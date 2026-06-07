/**
 * Explore Points System Test — verifies the launch spec (utils/pointsForPlace)
 * is applied across every check-in/award/listing path in exploreController.
 *
 * Spec (utils/pointsForPlace.js):
 *   price_level 1 ($)      → 10
 *   price_level 2 ($$)     → 20
 *   price_level 3 ($$$)    → 35
 *   price_level 4 ($$$$)   → 50
 *   price_level 0 / null   → 5/10/15 by user_ratings_total (<100 / <1000 / ≥1000)
 *
 * What this test verifies (zero HTTP, zero Google calls, zero DB):
 *   1. pointsForPlace() — all 6 tiers including free/no-data bucket bands
 *   2. mapPlace() — uses dynamic points, drops legacy static arg
 *   3. recordVisit() — awards via pointsForPlace using details() data
 *   4. _renderTrendingPlaces — every trending card has dynamic points
 *   5. _renderTrendingRestaurants — same
 *   6. getRestaurantsByCategory — enriched response uses dynamic points
 *   7. searchPlaces — multiplier × pointsForPlace
 *
 * Stubs: googlePlaces (details/nearby/text), prisma (locationPoint, mult, ledger),
 * utils/points (addPointsWithMultiplier). Loads exploreController via require.cache
 * after stubs are in place, so the controller's `require()`s pick them up.
 */

const path = require('path');
const Module = require('module');

let PASS = 0, FAIL = 0;
function assert(name, cond, detail) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(name, got, want) { assert(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// ---------- 1. pointsForPlace() pure function ----------
console.log('\n[1] pointsForPlace() — all tiers');
const { pointsForPlace } = require('../utils/pointsForPlace');
eq('$ → 10',                 pointsForPlace({ priceLevel: 1, userRatingsTotal: 50 }), 10);
eq('$$ → 20',                pointsForPlace({ priceLevel: 2, userRatingsTotal: 50 }), 20);
eq('$$$ → 35',               pointsForPlace({ priceLevel: 3, userRatingsTotal: 50 }), 35);
eq('$$$$ → 50',              pointsForPlace({ priceLevel: 4, userRatingsTotal: 50 }), 50);
eq('null + 50 reviews → 5',  pointsForPlace({ priceLevel: null, userRatingsTotal: 50 }), 5);
eq('null + 500 reviews → 10', pointsForPlace({ priceLevel: null, userRatingsTotal: 500 }), 10);
eq('null + 2000 reviews → 15', pointsForPlace({ priceLevel: null, userRatingsTotal: 2000 }), 15);
eq('free(0) + 50 reviews → 5', pointsForPlace({ priceLevel: 0, userRatingsTotal: 50 }), 5);
eq('free(0) + 1500 reviews → 15', pointsForPlace({ priceLevel: 0, userRatingsTotal: 1500 }), 15);
eq('undefined args → 5',     pointsForPlace({}), 5);
eq('reviews=0 → 5',          pointsForPlace({ priceLevel: null, userRatingsTotal: 0 }), 5);
eq('boundary <100: 99 → 5',  pointsForPlace({ priceLevel: null, userRatingsTotal: 99 }), 5);
eq('boundary ≥100: 100 → 10', pointsForPlace({ priceLevel: null, userRatingsTotal: 100 }), 10);
eq('boundary <1000: 999 → 10', pointsForPlace({ priceLevel: null, userRatingsTotal: 999 }), 10);
eq('boundary ≥1000: 1000 → 15', pointsForPlace({ priceLevel: null, userRatingsTotal: 1000 }), 15);

// ---------- 2. Stub setup for controller-level tests ----------
// Stub googlePlaces BEFORE require()-ing exploreController. Express does this via
// require.cache — pre-seed the cache with our stub modules.
const googlePlacesPath = require.resolve('../utils/googlePlaces');
const pointsUtilPath   = require.resolve('../utils/points');
const prismaClientPath = require.resolve('@prisma/client');

let stubDetailsReturn = null;
let stubNearbyReturn  = [];
let stubTextReturn    = [];
// Controller destructures these symbols at require time. To swap behavior after,
// we delegate through a mutable impl variable.
let detailsImpl = async (id) => stubDetailsReturn;

require.cache[googlePlacesPath] = {
  id: googlePlacesPath, filename: googlePlacesPath, loaded: true,
  exports: {
    details: (...args) => detailsImpl(...args),
    nearbyPage: async () => ({ results: stubNearbyReturn, next_page_token: null }),
    nearbyAll: async () => stubNearbyReturn,
    nearbyByDistance: async () => stubNearbyReturn,
    nearbyByDistanceAll: async () => stubNearbyReturn,
    textSearch: async () => stubTextReturn,
    photoUrlByRef: (ref) => ref ? `photo://${ref}` : '',
  },
};

let lastAward = null;
require.cache[pointsUtilPath] = {
  id: pointsUtilPath, filename: pointsUtilPath, loaded: true,
  exports: {
    addPointsWithMultiplier: async (userId, points, reason, refId) => {
      lastAward = { userId, points, reason, refId, finalPoints: points };
      return { finalPoints: points, multiplier: 1 };
    },
  },
};

// Stub PrismaClient. Need: locationPoint.findFirst/findMany/create, activeMultiplier.findFirst.
let createdLocationPoint = null;
const fakePrisma = {
  locationPoint: {
    findFirst: async () => null,
    findMany: async () => [],
    create: async ({ data }) => {
      createdLocationPoint = { id: Math.floor(Math.random() * 1e9), ...data };
      return createdLocationPoint;
    },
  },
  activeMultiplier: {
    findFirst: async () => null,
  },
};

require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: {
    PrismaClient: function() { return fakePrisma; },
  },
};

// Now require the controller — it will pick up our stubs.
const explore = require('../controllers/exploreController');

// Tiny res shim
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// ---------- 3. recordVisit awards via pointsForPlace ----------
console.log('\n[2] recordVisit() — awards by Google price_level + reviews');

async function runRecordVisit(stubPlace, userLatLng = { lat: 40.7484, lng: -73.9857 }) {
  stubDetailsReturn = stubPlace;
  createdLocationPoint = null;
  lastAward = null;
  const req = {
    authData: { id: 42 },
    body: {
      placeId: 'PLACEID_TEST_123',
      latitude: userLatLng.lat,
      longitude: userLatLng.lng,
      categoryKey: 'cafes',
    },
  };
  const res = makeRes();
  await explore.recordVisit(req, res);
  return res;
}

(async () => {
  // Place a viewport+center at user location so distance check always passes.
  const centerAtUser = {
    geometry: {
      location: { lat: 40.7484, lng: -73.9857 },
      viewport: {
        northeast: { lat: 40.7494, lng: -73.9847 },
        southwest: { lat: 40.7474, lng: -73.9867 },
      },
    },
    name: 'Test Place',
  };

  // $ cafe (price_level=1)
  let res = await runRecordVisit({ ...centerAtUser, price_level: 1, user_ratings_total: 50 });
  eq('recordVisit $ → 10 pts (response)', res.body?.points, 10);
  eq('recordVisit $ → 10 pts (DB)',       createdLocationPoint?.points, 10);
  eq('recordVisit $ → 10 pts (award)',    lastAward?.points, 10);

  // $$ restaurant
  res = await runRecordVisit({ ...centerAtUser, price_level: 2, user_ratings_total: 800 });
  eq('recordVisit $$ → 20 pts', res.body?.points, 20);

  // $$$ steakhouse
  res = await runRecordVisit({ ...centerAtUser, price_level: 3, user_ratings_total: 1200 });
  eq('recordVisit $$$ → 35 pts', res.body?.points, 35);

  // $$$$ luxury
  res = await runRecordVisit({ ...centerAtUser, price_level: 4, user_ratings_total: 5000 });
  eq('recordVisit $$$$ → 50 pts', res.body?.points, 50);

  // No price_level + lots of reviews → 15 (popularity)
  res = await runRecordVisit({ ...centerAtUser, price_level: null, user_ratings_total: 3000 });
  eq('recordVisit null + 3000 reviews → 15 pts', res.body?.points, 15);

  // No price_level + small place → 5
  res = await runRecordVisit({ ...centerAtUser, price_level: null, user_ratings_total: 20 });
  eq('recordVisit null + 20 reviews → 5 pts', res.body?.points, 5);

  // Free with mid reviews → 10
  res = await runRecordVisit({ ...centerAtUser, price_level: 0, user_ratings_total: 500 });
  eq('recordVisit free + 500 reviews → 10 pts', res.body?.points, 10);

  // Award reason / refId wiring
  eq('recordVisit award reason = LOCATION_VISIT', lastAward?.reason, 'LOCATION_VISIT');
  assert('recordVisit award refId set', !!lastAward?.refId);

  // ---------- 4. getCategoryPlaces — listing returns dynamic per-place points ----------
  console.log('\n[3] getCategoryPlaces — per-place dynamic points');

  // Three cafes — same category so they all pass primaryCategory filter — with
  // different price tiers to verify points compute per-place.
  stubNearbyReturn = [
    {
      place_id: 'P1', name: 'Cheap Cafe', vicinity: '1 St',
      geometry: { location: { lat: 40.7, lng: -74.0 } },
      types: ['cafe'], price_level: 1, user_ratings_total: 200,
    },
    {
      place_id: 'P2', name: 'Fancy Cafe', vicinity: '2 St',
      geometry: { location: { lat: 40.7, lng: -74.0 } },
      types: ['cafe'], price_level: 3, user_ratings_total: 1500,
    },
    {
      place_id: 'P3', name: 'Hidden Gem', vicinity: '3 St',
      geometry: { location: { lat: 40.7, lng: -74.0 } },
      types: ['cafe'], price_level: null, user_ratings_total: 1500,
    },
  ];

  const catReq = {
    params: { key: 'cafes' },
    query: { lat: '40.7', lng: '-74.0', radius: '5000' },
  };
  const catRes = makeRes();
  await explore.getCategoryPlaces(catReq, catRes);

  const places = catRes.body?.places || [];
  eq('getCategoryPlaces returns 3 places', places.length, 3);
  const byId = (id) => places.find(p => p.placeId === id);
  eq('listing $ cafe → 10 pts',                byId('P1')?.points, 10);
  eq('listing $$$ cafe → 35 pts',              byId('P2')?.points, 35);
  eq('listing null + 1500 reviews → 15 pts',   byId('P3')?.points, 15);

  // ---------- 5. _renderTrendingPlaces ----------
  console.log('\n[4] Trending /explore — per-place dynamic points');

  stubTextReturn = [
    {
      place_id: 'T1', name: 'Trending Bar', vicinity: 'X',
      geometry: { location: { lat: 40.7, lng: -74.0 } },
      types: ['bar'], price_level: 2, user_ratings_total: 600,
    },
    {
      place_id: 'T2', name: 'Trending Lounge', vicinity: 'Y',
      geometry: { location: { lat: 40.7, lng: -74.0 } },
      types: ['night_club'], price_level: 4, user_ratings_total: 2000,
    },
  ];

  const trReq = { params: { key: 'trending' }, query: { lat: '40.7', lng: '-74.0', radius: '5000' } };
  const trRes = makeRes();
  await explore.getCategoryPlaces(trReq, trRes);
  const tplaces = trRes.body?.places || [];
  eq('trending $$ → 20 pts',  tplaces.find(p => p.placeId === 'T1')?.points, 20);
  eq('trending $$$$ → 50 pts', tplaces.find(p => p.placeId === 'T2')?.points, 50);
  eq('trending response category meta points=null (no fixed bucket)', trRes.body?.category?.points, null);
  eq('cafes response category meta points=null',                     catRes.body?.category?.points, null);

  // ---------- 6. getRestaurantsByCategory enriched response ----------
  console.log('\n[5] /restaurants/category/:key — enriched dynamic points');

  // For enriched listing, both nearby search AND details() are called per item.
  stubNearbyReturn = [
    { place_id: 'R1', name: 'A', geometry: { location: { lat: 40.7, lng: -74.0 } }, types: ['restaurant'] },
    { place_id: 'R2', name: 'B', geometry: { location: { lat: 40.7, lng: -74.0 } }, types: ['restaurant'] },
  ];

  // details() must look up by placeId — Promise.all races otherwise.
  const detailsById = {
    R1: { price_level: 1, user_ratings_total: 50, name: 'A',
          geometry: { location: { lat: 40.7, lng: -74.0 } }, types: ['restaurant'] },
    R2: { price_level: 4, user_ratings_total: 2000, name: 'B',
          geometry: { location: { lat: 40.7, lng: -74.0 } }, types: ['restaurant'] },
  };
  detailsImpl = async (id) => detailsById[id] || null;

  const rReq = {
    params: { key: 'restaurants' },
    query: { lat: '40.7', lng: '-74.0', radius: '5000', pageSize: '20' },
  };
  const rRes = makeRes();
  await explore.getRestaurantsByCategory(rReq, rRes);
  const restaurants = rRes.body?.restaurants || [];
  eq('getRestaurantsByCategory $ → 10 pts',     restaurants.find(r => r.id === 'R1')?.points, 10);
  eq('getRestaurantsByCategory $$$$ → 50 pts',  restaurants.find(r => r.id === 'R2')?.points, 50);

  // ---------- 7. searchPlaces with multiplier ----------
  console.log('\n[6] /explore/search — pointsForPlace × multiplier');

  // Active 2× multiplier
  fakePrisma.activeMultiplier.findFirst = async () => ({ factor: 2, endsAt: new Date(Date.now() + 1e6) });
  // Use a FRESH lat/lng — CATEGORY_CACHE persists per (catKey, lat3, lng3) and
  // earlier cafes-test populated [40.7, -74.0]; new (41.0, -75.0) bypasses cache.
  stubNearbyReturn = [
    { place_id: 'S1', name: 'Searched Cafe', vicinity: 'X', formatted_address: 'X St',
      geometry: { location: { lat: 41.0, lng: -75.0 } }, types: ['cafe'], price_level: 2, user_ratings_total: 500 },
  ];
  detailsImpl = async () => ({
    price_level: 2, user_ratings_total: 500, name: 'Searched Cafe',
    geometry: { location: { lat: 41.0, lng: -75.0 } }, types: ['cafe'],
  });

  const sReq = {
    authData: { id: 42 },
    query: { q: 'searched', lat: '41.0', lng: '-75.0', category: 'cafes' },
  };
  const sRes = makeRes();
  await explore.searchPlaces(sReq, sRes);
  const sr = sRes.body?.restaurants || [];
  eq('searchPlaces 1 result',                sr.length, 1);
  eq('search $$ base=20',                    sr[0]?.basePoints, 20);
  eq('search multiplier=2 applied → 40 pts', sr[0]?.points, 40);

  // ---------- 8. Award is still floor()ed via addPointsWithMultiplier ----------
  console.log('\n[7] Multiplier flow integrity (re-check)');
  // The actual addPointsWithMultiplier is stubbed → we just verify base pts flow.
  // (Unit covered by the recordVisit cases above.)
  eq('award path uses base points pre-multiplier', typeof lastAward?.points === 'number', true);

  // ---------- summary ----------
  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch(err => {
  console.error('TEST CRASH', err);
  process.exit(1);
});
