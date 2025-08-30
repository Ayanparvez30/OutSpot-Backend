// utils/googlePlaces.js
// Node 18+ হলে global fetch আছে; পুরনো হলে: npm i node-fetch && const fetch = require('node-fetch');

const GMAPS_BASE = 'https://maps.googleapis.com/maps/api/place';

const fieldsForDetails = [
  'place_id','name','formatted_address','geometry/location','types',
  'photos','opening_hours/open_now','rating','user_ratings_total'
].join(',');

function photoUrlByRef(photoRef, maxwidth = 400) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!photoRef || !key) return null;
  // client থেকে সরাসরি লোড করা যাবে
  return `${GMAPS_BASE}/photo?maxwidth=${maxwidth}&photoreference=${photoRef}&key=${key}`;
}

async function nearby({ lat, lng, radius = 2500, keyword, type }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Missing GOOGLE_MAPS_API_KEY');
  const params = new URLSearchParams({
    key,
    location: `${lat},${lng}`,
    radius: String(radius)
  });
  if (keyword) params.set('keyword', keyword);
  if (type) params.set('type', type);

  const url = `${GMAPS_BASE}/nearbysearch/json?${params.toString()}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.status !== 'OK' && j.status !== 'ZERO_RESULTS') {
    throw new Error(`Places Nearby error: ${j.status} ${j.error_message || ''}`);
  }
  return j.results || [];
}

async function details(place_id) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const url = `${GMAPS_BASE}/details/json?place_id=${place_id}&fields=${encodeURIComponent(fieldsForDetails)}&key=${key}`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.status !== 'OK') throw new Error(`Places Details error: ${j.status} ${j.error_message || ''}`);
  return j.result;
}

module.exports = { nearby, details, photoUrlByRef };
