// Creates cost raster based on Tobler's hiking cost function, capped at 10000
function computeToblersCost (slope, waterMask) {
  // Convert slope to radians
  var slopeInRad = slope.multiply(Math.PI / 180);

  // Apply Tobler's formula
  var landCost = slopeInRad.add(0.05)
    .tan()
    .abs()
    .multiply(-3.5)
    .exp()
    .multiply(6)
    .pow(-1)
    .min(10000);  // cap the Tobler cost itself before combining

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
var water_mask = occurrence.gt(90).unmask(0);
Map.addLayer({
  eeObject: water_mask,
  visParams: VIS_WATER_MASK,
  name: '90% occurrence water mask'
});

// IF to use quick approximation of land/sea mask purely based on elevation
//var landSeaMask = dem.where(dem.lte(0), 10000).where(dem.gt(0), 1);
//Map.addLayer(landSeaMask, {min: 0, max: 10000, palette: ['blue', 'green']}, 'Land/Sea Mask');

// Create cost raster
var tobCost = computeToblersCost(slope, water_mask);
//Map.addLayer(tobCost, {min: 0, max: 10000, palette: ['white', 'green', 'yellow', 'red']}, 'Cost Surface');

// Converting the point to image
var startPoint = ee.FeatureCollection('');
Map.addLayer(startPoint, {color: 'blue'}, 'Start Point');
var midPoint = ee.FeatureCollection('');
Map.addLayer(midPoint, {color: 'blue'}, 'Mid Point');
var endPoint = ee.FeatureCollection('');
Map.addLayer(endPoint, {color: 'blue'}, 'End Point');

var startPointImage = startPoint
  .map(function(f) { return f.set('constant', 1); }) // assign constant value
  .reduceToImage({
    properties: ['constant'],
    reducer: ee.Reducer.first()
  });
  
var midPointImage = midPoint
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
  
// specify region of interest
var roi = startPoint.first().geometry().buffer(60000).bounds();
var clippedCost = tobCost.clip(roi);
Map.addLayer(roi, {color: 'purple'}, 'ROI');

// Run cumulative cost function
var cCostFromStart = clippedCost.cumulativeCost(startPointImage, 70000, false)
var cCostFromMid = clippedCost.cumulativeCost(midPointImage, 70000, false)
var cCostFromEnd = tobCost.cumulativeCost(endPointImage, 70000, false)
//Map.addLayer(cCostFromMid, {min: 0, max: 30000, palette: ['white', 'yellow', 'orange', 'red', 'black']}, 'Cumulative Cost from mid')
//Map.addLayer(cCostFromStart, {min: 0, max: 30000, palette: ['white', 'yellow', 'orange', 'red', 'black']}, 'Cumulative Cost from start')
//Map.addLayer(cCostFromEnd, {min: 0, max: 30000, palette: ['white', 'yellow', 'orange', 'red', 'black']}, 'Cumulative Cost from end')

// Add the two cumulative cost rasters
var startMidAddedCost = cCostFromStart.add(cCostFromMid).clip(roi);
var startEndAddedCost = cCostFromStart.add(cCostFromEnd).clip(roi);

// Declare how much to scale up the raster by to increase computation speed
// This appears to have the largest impact on computation time
var scale_up = 8;

// Find the minimum cost from startMidAddedCost raster
var startMidMinCostDict = startMidAddedCost.reduceRegion({
  // reducer being min means we are getting the minimum from all pixels in addedCost
  reducer: ee.Reducer.min(),
  geometry: clippedCost.geometry(),
  scale: 30 * scale_up,  // using a coarser scale for better speed
  maxPixels: 1e13,
  // if too many pixels at given scale, bestEffort uses a larger scale to ensure function runs successfully
  bestEffort: true
});

var startMidMinCost = ee.Number(startMidMinCostDict.get('cumulative_cost'));
print(startMidMinCost);

// Get pixels in LCC by selecting those with cost ≤ minCost + threshold
// tolerance has same units as cost, which is derived from Tobler's hiking function
var tolerance = 20;
var startMidLeastCostCorridor = startMidAddedCost.lte(startMidMinCost.add(tolerance));

// Convert the raster path to a vector. This is more robust for visualization.
var startMidPathVector = startMidLeastCostCorridor.selfMask().reduceToVectors({
  geometry: clippedCost.geometry(),
  scale: 30 * scale_up,
  geometryType: 'polygon',
  eightConnected: true,
  bestEffort: true
});

// Style the vector path to be a thick, bright red line.
var startMidStyledPath = startMidPathVector.style({
  color: 'FF0000', // Bright red
  width: 1       // Line width in pixels
});

// Add the styled path to the map.
Map.addLayer(startMidStyledPath, {}, 'Least-Cost Path (Styled Vector)');
print(startMidLeastCostCorridor);

// Export if necessary
//Export.table.toDrive({
//  collection: pathVector,
//  description: 'lcc_export',
//  fileFormat: 'SHP'
//});

// Increasing scale_up for larger search area from start to end
var scale_up = 6;

// Find the minimum cost from startEndAddedCost raster
var startEndMinCostDict = startEndAddedCost.reduceRegion({
  // reducer being min means we are getting the minimum from all pixels in addedCost
  reducer: ee.Reducer.min(),
  geometry: clippedCost.geometry(),
  scale: 30 * scale_up,  // using a coarser scale for better speed
  maxPixels: 1e13,
  // if too many pixels at given scale, bestEffort uses a larger scale to ensure function runs successfully
  bestEffort: true
});

var startEndMinCost = ee.Number(startEndMinCostDict.get('cumulative_cost'));

// Get pixels in LCC by selecting those with cost ≤ minCost + threshold
// tolerance has same units as cost, which is derived from Tobler's hiking function
var tolerance = 5;
var startEndLeastCostCorridor = startEndAddedCost.lte(startEndMinCost.add(tolerance));

// Convert the raster path to a vector. This is more robust for visualization
var startEndPathVector = startEndLeastCostCorridor.selfMask().reduceToVectors({
  geometry: clippedCost.geometry(),
  scale: 30 * scale_up,
  geometryType: 'polygon',
  eightConnected: true,
  bestEffort: true
});

// Style the vector path to be a thick, bright red line
var startEndStyledPath = startEndPathVector.style({
  color: '17ff00', // Bright green
  width: 3       // Line width in pixels
});

// Add the styled path to the map
Map.addLayer(startEndStyledPath, {}, 'Least-Cost Path (Styled Vector)');
Map.centerObject(midPoint, 9.5);

// Convolution edge detection

// Perform edge detection on entire cost raster (quick processing) to find sharp elevation changes
var laplacian = ee.Kernel.laplacian8({ normalize: false });
var edges = clippedCost.convolve(laplacian);

// Take the absolute value. High values are now edges/slopes, values near zero are flat
var absEdges = edges.abs();

// Filter for low gradient points.
// We select pixels where the edge value is less than a threshold
// This effectively inverts the edge map, showing flat areas instead of steep ones
// ADJUST THIS THRESHOLD to control how "flat" an area must be to be included
var lowGradientThreshold = 0.02;
var lowGradientAreas = absEdges.lte(lowGradientThreshold).selfMask();

//Map.addLayer(lowGradientAreas, {palette: ['white']}, 'Low Gradient Areas');
// Add the image of low-gradient areas clipped to corridors
var lowGradientStartMidCorr = lowGradientAreas.clip(startMidPathVector);
var lowGradientStartEndCorr = lowGradientAreas.clip(startEndPathVector);
Map.addLayer(lowGradientStartMidCorr, {palette: ['#F5EF42']}, 'Low Gradient Areas in Start Mid Corridor');
Map.addLayer(lowGradientStartEndCorr, {palette: ['#F5EF42']}, 'Low Gradient Areas in Start End Corridor');

// Import least cost paths generated from QGIS
var startMidLCP = ee.FeatureCollection('');
Map.addLayer(startMidLCP, {color: 'blue'}, 'Start Mid LCP');
var startEndLCP = ee.FeatureCollection('');
Map.addLayer(startEndLCP, {color: 'blue'}, 'Start End LCP');

// Import least cost paths generated from ArcGIS
var startMidLCPArc = ee.FeatureCollection('');
Map.addLayer(startMidLCPArc, {color: 'pink'}, 'Start Mid LCP ArcGIS');
var startEndLCPArc = ee.FeatureCollection('');
Map.addLayer(startEndLCPArc, {color: 'pink'}, 'Start End LCP ArcGIS');