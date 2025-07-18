// Percentage threshold of water occurrence to be considered surface water body
var water_mask_threshold = 90;
// Area to be considered ROI /////// WILL NEED TO BE DYNAMICALLY DETERMINED
var roi_area = 200000
// Tolerance for acceptance in LCC
var initial_tolerance_percentage = 0.05;
// Controls how "flat" an area must be to be included
var lowGradientThreshold = 0.02;
// Creates cost raster based on Tobler's hiking cost function, capped at 10000
function computeAnayaCost (slope, waterMask) {
  // Apply Anaya Hernandez cost function
  var slopeSquared = slope.pow(2);
  var landCost = slopeSquared.multiply(0.031)
                  .add(slope.multiply(-0.025))
                  .add(1)
                  .min(10000);  // cap the cost itself before combining

  // Apply water mask
  var fullCost = landCost
    .where(waterMask.eq(1), 10000);  // set cost=10000 where it is water

  return fullCost;
}

// Load DEM and calculate slope
var dem = ee.Image('NASA/NASADEM_HGT/001').select('elevation');
var slope = ee.Terrain.slope(dem);
Map.addLayer(slope, {min: 0, max: 89.99}, 'Slope');

var gsw = ee.Image("JRC/GSW1_4/GlobalSurfaceWater");
var occurrence = gsw.select('occurrence');
var VIS_WATER_MASK = {
palette: ['white', 'black']
};
// Create a water mask layer, and set the image mask so that non-water areas are opaque.
var water_mask = occurrence.gt(water_mask_threshold).unmask(0);
Map.addLayer({
eeObject: water_mask,
visParams: VIS_WATER_MASK,
name: '90% occurrence water mask'
});

// IF to use quick approximation of land/sea mask purely based on elevation
//var landSeaMask = dem.where(dem.lte(0), 10000).where(dem.gt(0), 1);
//Map.addLayer(landSeaMask, {min: 0, max: 10000, palette: ['blue', 'green']}, 'Land/Sea Mask');

// Create cost raster
var anayaCost = computeAnayaCost(slope, water_mask);
//Map.addLayer(tobCost, {min: 0, max: 10000, palette: ['white', 'green', 'yellow', 'red']}, 'Cost Surface');

// Converting the point to image
var startPointGeom = ee.Geometry.Point(11.3433660186036, 44.5037205375293);
var startPoint= ee.FeatureCollection(startPointGeom)
var endPointGeom = ee.Geometry.Point(9.18917709156214, 45.4658836780192);
var endPoint = ee.FeatureCollection(endPointGeom);

// specify region of interest
var roi = startPoint.first().geometry().buffer(roi_area).bounds();
var clippedCost = anayaCost.clip(roi);
Map.addLayer(roi, {color: 'purple'}, 'ROI');

// Convolution edge detection
// Perform edge detection on entire cost raster (this is quick to process) to find sharp elevation changes
var laplacian = ee.Kernel.laplacian8({ normalize: false });
var edges = clippedCost.convolve(laplacian);
// Take the absolute value. High values are now edges/slopes, values near zero are flat
var absEdges = edges.abs();
// Filter for low gradient points. We select pixels where the edge value is less than a threshold
// This effectively inverts the edge map, showing flat areas instead of steep ones
var lowGradientAreas = absEdges.lte(lowGradientThreshold).selfMask();

// Perform least cost corridor search with increasing dimension rasters 3 times from startPoint to endPoint
function three_raster_lcc(startPoint, endPoint) {
  var startPointImage = startPoint
  .map(function(f) { return f.set('constant', 1); }) // assign constant value
  .reduceToImage({
    properties: ['constant'],
    reducer: ee.Reducer.first()
  });

  var endPointImage = endPoint
  .map(function(f) { return f.set('constant', 1); }) // assign constant value
  .reduceToImage({
    properties: ['constant'],
    reducer: ee.Reducer.first()
  });

  // Run cumulative cost function
  var cCostFromStart = clippedCost.cumulativeCost(startPointImage, 250000, false);
  var cCostFromEnd = clippedCost.cumulativeCost(endPointImage, 250000, false);

  // Add the two cumulative cost rasters
  var startEndAddedCost1 = cCostFromStart.add(cCostFromEnd).clip(roi);

  // Round 1
  // Declare how much to scale up the raster by to increase computation speed
  var scale_up1 = 50;

  // Find the minimum cost from startEndAddedCost raster
  var startEndMinCostDict1 = startEndAddedCost1.reduceRegion({
  // reducer being min means we are getting the minimum from all pixels in addedCost
  reducer: ee.Reducer.min(),
  geometry: startEndAddedCost1.geometry(),
  scale: 30 * scale_up1,  // using a coarser scale for better speed
  maxPixels: 1e13,
  // if too many pixels at given scale, bestEffort uses a larger scale to ensure function runs successfully
  bestEffort: true
  });

  var startEndMinCost1 = ee.Number(startEndMinCostDict1.get('cumulative_cost'));

  // Get pixels in LCC by selecting those with cost ≤ minCost + threshold
  // tolerance has same units as cost, which is derived from Tobler's hiking function
  var tolerance1 = startEndMinCost1.multiply(initial_tolerance_percentage);
  var startEndLeastCostCorridor1 = startEndAddedCost1.lte(startEndMinCost1.add(tolerance1));

  // Convert the raster path to a vector. This is more robust for visualization
  var startEndPathVector1 = startEndLeastCostCorridor1.selfMask().reduceToVectors({
  geometry: clippedCost.geometry(),
  scale: 30 * scale_up1,
  geometryType: 'polygon',
  eightConnected: true,
  bestEffort: true
  });

  // Round 2
  var scale_up2 = 25;
  var tolerance2 = 25;

  var startEndAddedCost2 = startEndAddedCost1.clip(startEndPathVector1);

  var startEndMinCostDict2 = startEndAddedCost2.reduceRegion({
  reducer: ee.Reducer.min(),
  geometry: startEndAddedCost2.geometry(),
  scale: 30 * scale_up2,
  maxPixels: 1e13,
  bestEffort: true
  });

  var startEndMinCost2 = ee.Number(startEndMinCostDict2.get('cumulative_cost'));

  var startEndLeastCostCorridor2 = startEndAddedCost2.lte(startEndMinCost2.add(tolerance2));

  var startEndPathVector2 = startEndLeastCostCorridor2.selfMask().reduceToVectors({
  geometry: startEndAddedCost2.geometry(),
  scale: 30 * scale_up2,
  geometryType: 'polygon',
  eightConnected: true,
  bestEffort: true
  });

  // Round 3
  var scale_up3 = 12;
  var tolerance3 = 1;

  var startEndAddedCost3 = startEndAddedCost2.clip(startEndPathVector2);

  var startEndMinCostDict3 = startEndAddedCost3.reduceRegion({
  reducer: ee.Reducer.min(),
  geometry: startEndAddedCost3.geometry(),
  scale: 30 * scale_up3,
  maxPixels: 1e13,
  bestEffort: true
  });

  var startEndMinCost3 = ee.Number(startEndMinCostDict3.get('cumulative_cost'));

  var startEndLeastCostCorridor3 = startEndAddedCost3.lte(startEndMinCost3.add(tolerance3));

  var startEndPathVector3 = startEndLeastCostCorridor3.selfMask().reduceToVectors({
  geometry: startEndAddedCost3.geometry(),
  scale: 30 * scale_up3,
  geometryType: 'polygon',
  eightConnected: true,
  bestEffort: true
  });

  return startEndPathVector3;
}

function add_path_layers(pathVector, label) {
  var startEndStyledPath = pathVector.style({
  color: '17ff00', // Bright green
  width: 3       // Line width in pixels
  });
  
  Map.addLayer(startEndStyledPath, {}, 'Least Cost Corridor ' + label);
  Map.addLayer(lowGradientAreas.clip(pathVector), {palette: ['#F5EF42']}, 'Low Gradient Areas in Corridor ' + label);
}

Map.centerObject(startPoint, 8);

// Add points in between
var point1Geom = ee.Geometry.Point(11.0526954912152, 44.595602489102);
var point1 = ee.FeatureCollection(point1Geom);
//add_path_layers(three_raster_lcc(startPoint, point1), 'Start-1');
var point2Geom = ee.Geometry.Point(10.9251527123913, 44.6470689132215);
var point2 = ee.FeatureCollection(point2Geom);
//add_path_layers(three_raster_lcc(point1, point2), '1-2');
var point3Geom = ee.Geometry.Point(10.7790069173826, 44.6540878517765);
var point3 = ee.FeatureCollection(point3Geom);
//add_path_layers(three_raster_lcc(point2, point3), '2-3');
var point4Geom = ee.Geometry.Point(10.6298059531519, 44.6989918768963);
var point4 = ee.FeatureCollection(point4Geom);
//add_path_layers(three_raster_lcc(point3, point4), '3-4');
var point5Geom = ee.Geometry.Point(10.3254918017869, 44.8017940139929);
var point5 = ee.FeatureCollection(point5Geom);
//add_path_layers(three_raster_lcc(point4, point5), '4-5');
var point6Geom = ee.Geometry.Point(9.69696430808572, 45.0513627103219);
var point6 = ee.FeatureCollection(point6Geom);
//add_path_layers(three_raster_lcc(point5, point6), '5-6');
var point7Geom = ee.Geometry.Point(9.5029900028069, 45.311166366664);
var point7 = ee.FeatureCollection(point7Geom);
//add_path_layers(three_raster_lcc(point6, point7), '6-7');
var point8Geom = ee.Geometry.Point(9.32018746590149, 45.3553880723531);
var point8 = ee.FeatureCollection(point8Geom);
//add_path_layers(three_raster_lcc(point7, point8), '7-8');
//add_path_layers(three_raster_lcc(point8, endPoint), '8-End');
add_path_layers(three_raster_lcc(startPoint, endPoint), 'Start-End');
Map.addLayer(point1, {color: 'blue'}, 'Point 1');
Map.addLayer(point2, {color: 'blue'}, 'Point 2');
Map.addLayer(point3, {color: 'blue'}, 'Point 3');
Map.addLayer(point4, {color: 'blue'}, 'Point 4');
Map.addLayer(point5, {color: 'blue'}, 'Point 5');
Map.addLayer(point6, {color: 'blue'}, 'Point 6');
Map.addLayer(point7, {color: 'blue'}, 'Point 7');
Map.addLayer(point8, {color: 'blue'}, 'Point 8');
Map.addLayer(startPoint, {color: 'blue'}, 'Start Point');
Map.addLayer(endPoint, {color: 'blue'}, 'End Point');