// Idempotent seed for the launch challenge catalog.
//
// Run with:   node scripts/seedChallenges.js
// Or via:     npm run seed:challenges
//
// Uses `prisma.challenge.upsert` keyed on the [title, frequency] unique
// constraint, so re-running is safe — existing rows are updated to the
// latest spec, new rows are inserted, untouched ones are left alone.
//
// SCOPE (matches the launch PDF, minus anything that requires a Flutter
// flow change):
//   - 100 daily challenge ideas (food, coffee, views, city, art, fitness,
//                                 social-solo, shopping)
//   - 40 weekly multi-stop ideas
//   - 14 weekend-only challenges (weekendOnly=true)
//   - 40 seasonal challenges (10 per season)
//   - 15 higher-value bonus weekly challenges
//   - 19 brand-named flavor challenges
//   - 45 health & wellness daily (health/fitness/mental)
//   - 15 weekly health challenges
//
// EXCLUDED (need new Flutter flows — friend invite, head-to-head voting,
// group coordination, multi-challenge meta-completion UI):
//   - "Challenges To Do With A Friend" (simple/active/competitive/group/combo)
//   - "Spot Snap Win Challenge" (meta — complete any 3 in one day)

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { pointsForDifficulty } = require('../utils/challengeDifficulty');

const prisma = new PrismaClient();

// Build a Challenge row with sensible defaults so each entry below stays terse.
function ch(title, description, opts = {}) {
  const difficulty = opts.difficulty || 'EASY';
  const points = opts.points ?? pointsForDifficulty(difficulty);
  const tier = points >= 20 ? 'GOLD' : 'SILVER';
  return {
    title,
    description,
    frequency: opts.frequency || 'DAILY',
    difficulty,
    points,
    tier,
    requiredPhotos: opts.requiredPhotos || 1,
    weekendOnly: !!opts.weekendOnly,
    season: opts.season || null,
    type: opts.type || null,
    isActive: opts.isActive === false ? false : true,
    isFeatured: !!opts.isFeatured,
  };
}

// ===================== DAILY CHALLENGE IDEAS (100) =====================
const DAILY = [
  // Food & Drink (20)
  ch('Lunch Spot', 'Show your lunch spot today', { type: 'food' }),
  ch('Favorite Pizza', 'Snap your favorite pizza slice', { type: 'food' }),
  ch('Best Taco Near You', 'Find the best taco near you', { type: 'food' }),
  ch('10/10 Dessert', 'Show a dessert you would rate 10/10', { type: 'food' }),
  ch('Smoothie or Juice', 'Snap your favorite smoothie or juice', { type: 'food' }),
  ch('Go-To Boba', 'Show your go-to boba drink', { type: 'food' }),
  ch('Hidden Bakery', 'Find a hidden bakery', { type: 'food', difficulty: 'MEDIUM' }),
  ch('Favorite Burger', 'Snap your favorite burger', { type: 'food' }),
  ch('Best-Looking Pasta', 'Show your best-looking pasta dish', { type: 'food' }),
  ch('Food Truck Find', 'Visit a food truck and snap your order', { type: 'food', difficulty: 'MEDIUM' }),
  ch('Favorite Ice Cream', 'Show your favorite ice cream flavor', { type: 'food' }),
  ch('Colorful Meal', 'Snap a colorful meal', { type: 'food' }),
  ch('Late-Night Snack', 'Show your late-night snack', { type: 'food' }),
  ch('Outdoor Seating Restaurant', 'Find a restaurant with outdoor seating', { type: 'food' }),
  ch('Favorite Brunch Plate', 'Snap your favorite brunch plate', { type: 'food' }),
  ch('Favorite Fries', 'Show your favorite fries', { type: 'food' }),
  ch('Best Sandwich Near You', 'Find the best sandwich near you', { type: 'food' }),
  ch('Drink With A View', 'Snap a drink with a view', { type: 'food' }),
  ch('Hidden Local Restaurant', 'Show a local restaurant you think more people should know about', { type: 'food', difficulty: 'MEDIUM' }),
  ch('Something Spicy', 'Snap something spicy', { type: 'food' }),

  // Coffee, Cafes & Study Spots (10)
  ch('Favorite Coffee Shop', 'Show your favorite coffee shop', { type: 'coffee' }),
  ch('Morning Coffee', 'Snap your morning coffee', { type: 'coffee' }),
  ch('Cool Cafe Interior', 'Find a cafe with cool interior design', { type: 'coffee', difficulty: 'MEDIUM' }),
  ch('Favorite Study Spot', 'Show your favorite study spot', { type: 'coffee' }),
  ch('Latte Art', 'Snap a latte art design', { type: 'coffee' }),
  ch('Coziest Cafe', 'Find the coziest cafe nearby', { type: 'coffee', difficulty: 'MEDIUM' }),
  ch('Cafe With Outdoor Seating', 'Show a cafe with outdoor seating', { type: 'coffee' }),
  ch('Tea or Matcha', 'Snap your favorite tea or matcha', { type: 'coffee' }),
  ch('Untried Cafe', 'Find a cafe you have never tried before', { type: 'coffee', difficulty: 'MEDIUM' }),
  ch('Favorite Cafe Pastry', 'Show your favorite pastry at a cafe', { type: 'coffee' }),

  // Views, Nature & Outdoors (15)
  ch('Best View From Here', 'Snap the best view from where you are', { type: 'outdoors' }),
  ch('Favorite Park', 'Show your favorite park', { type: 'outdoors' }),
  ch('Peaceful Bench', 'Find a peaceful bench', { type: 'outdoors' }),
  ch('Tree, Flower, or Plant', 'Snap a cool tree, flower, or plant', { type: 'outdoors' }),
  ch('Waterfront View', 'Show a waterfront view', { type: 'outdoors' }),
  ch('Best Skyline View', 'Find the best skyline view', { type: 'outdoors', difficulty: 'HARD' }),
  ch('Moon Tonight', 'Snap the moon tonight', { type: 'outdoors', difficulty: 'HARD' }),
  ch('Cloud Formation', 'Show a cloud formation that looks interesting', { type: 'outdoors' }),
  ch('Favorite Walking Route', 'Snap your favorite walking route', { type: 'outdoors' }),
  ch('Quiet Outdoor Place', 'Find a quiet place outdoors', { type: 'outdoors' }),
  ch('View From A Bridge', 'Show the best view from a bridge', { type: 'outdoors', difficulty: 'HARD' }),
  ch('Something Green', 'Snap something green', { type: 'outdoors' }),
  ch('Favorite Trail or Path', 'Show your favorite trail or path', { type: 'outdoors', difficulty: 'HARD' }),
  ch('Good Sunlight Spot', 'Find a place with good sunlight', { type: 'outdoors' }),
  ch('Reflection Shot', 'Snap a reflection in water, glass, or a mirror', { type: 'outdoors' }),

  // City Exploration (15)
  ch('Cool Building', 'Snap a cool building', { type: 'city' }),
  ch('Favorite Street Corner', 'Show your favorite street corner', { type: 'city' }),
  ch('Colorful Wall', 'Find a colorful wall', { type: 'city' }),
  ch('Unique Storefront', 'Snap a unique storefront', { type: 'city' }),
  ch('Interesting Street Sign', 'Show a street sign with an interesting name', { type: 'city' }),
  ch('Walk-Past Place', 'Find a place you have walked past but never entered', { type: 'city', difficulty: 'MEDIUM' }),
  ch('Cool Doorway', 'Snap a cool doorway or entrance', { type: 'city' }),
  ch('Local Landmark', 'Show a local landmark', { type: 'city', difficulty: 'HARD' }),
  ch('Hidden Alley', 'Find a hidden alley or side street', { type: 'city', difficulty: 'MEDIUM' }),
  ch('Favorite Neighborhood Spot', 'Snap your favorite neighborhood spot', { type: 'city' }),
  ch('Busy City Moment', 'Show a busy city moment', { type: 'city' }),
  ch('Neon Lights', 'Find a place with neon lights', { type: 'city' }),
  ch('Public Clock or Fountain', 'Snap a public clock, fountain, or statue', { type: 'city' }),
  ch('Cool Staircase', 'Show a cool staircase', { type: 'city' }),
  ch('Underrated Place', 'Find a place that feels underrated', { type: 'city', difficulty: 'MEDIUM' }),

  // Art, Culture & Creativity (10)
  ch('Mural Mission', 'Show a mural', { type: 'art' }),
  ch('Public Art', 'Snap public art', { type: 'art' }),
  ch('Local Event Poster', 'Find a poster or flyer for a local event', { type: 'art' }),
  ch('Creative Shop Window', 'Show a creative shop window', { type: 'art' }),
  ch('Sculpture', 'Snap a sculpture', { type: 'art' }),
  ch('Unnoticed Street Art', 'Find street art you have never noticed before', { type: 'art', difficulty: 'MEDIUM' }),
  ch('Colorful City Design', 'Show a colorful design in the city', { type: 'art' }),
  ch('Museum, Gallery, or Cultural Spot', 'Snap a museum, gallery, or cultural spot', { type: 'art', difficulty: 'HARD' }),
  ch('Local Performance', 'Show a local performance or musician from a respectful distance', { type: 'art' }),
  ch('Something Handmade', 'Find something handmade', { type: 'art' }),

  // Fitness & Activity (10)
  ch('Someone Playing A Sport', 'Show someone playing a sport', { type: 'fitness' }),
  ch('Fitness Spot', 'Snap a gym, field, court, or fitness spot', { type: 'fitness' }),
  ch('Walking Goal Progress', 'Show your walking goal progress', { type: 'fitness' }),
  ch('People Exercising', 'Find a place where people are exercising', { type: 'fitness' }),
  ch('Bike Rack or Biking Path', 'Snap a bike rack or biking path', { type: 'fitness' }),
  ch('Basketball Court', 'Show a basketball court', { type: 'fitness' }),
  ch('Running Trail', 'Find a running trail', { type: 'fitness', difficulty: 'HARD' }),
  ch('Fitness Class Sign', 'Snap a yoga, dance, or fitness class sign', { type: 'fitness' }),
  ch('Outdoor Workout Spot', 'Show a place where you would work out outdoors', { type: 'fitness' }),
  ch('Sports Field or Stadium', 'Find a sports field or stadium', { type: 'fitness', difficulty: 'HARD' }),

  // Friends & Social (solo-completable, 10)
  ch('Group Hangout Spot', 'Snap a group hangout spot', { type: 'social' }),
  ch('Friends Chill Spot', 'Show where you and your friends would chill', { type: 'social' }),
  ch('Matching Drinks or Meals', 'Take a photo of matching drinks or meals', { type: 'social' }),
  ch('Board Game or Arcade Spot', 'Show a board game, arcade, or activity spot', { type: 'social' }),
  ch('First Date Spot', 'Snap a place perfect for a first date', { type: 'social' }),
  ch('Visitor-Worthy Spot', 'Show a place you would bring someone visiting your city', { type: 'social' }),
  ch('Fun Weekend Hangout', 'Find a fun weekend hangout place', { type: 'social' }),
  ch('Good Time Place', 'Snap a place where people are having a good time', { type: 'social' }),
  ch('Favorite Meetup Place', 'Show your favorite place to meet friends', { type: 'social' }),
  ch('Good Music or Vibes', 'Find a spot with good music or vibes', { type: 'social' }),

  // Shopping & Local Businesses (10)
  ch('Favorite Local Store', 'Show your favorite local store', { type: 'shopping' }),
  ch('Cool Thrift Find', 'Snap a cool thrift find', { type: 'shopping' }),
  ch('Small Business To Support', 'Find a small business you want to support', { type: 'shopping' }),
  ch('Bookstore', 'Show a bookstore', { type: 'shopping' }),
  ch('Flower Shop', 'Snap a flower shop', { type: 'shopping' }),
  ch('Unique Gift Shop', 'Find a unique gift shop', { type: 'shopping' }),
  ch('Local Market', 'Show a local market', { type: 'shopping' }),
  ch('Cool Clothing Display', 'Snap a cool clothing display', { type: 'shopping' }),
  ch('Best Window Design', 'Find a shop with the best window design', { type: 'shopping' }),
  ch('Handmade Goods Shop', 'Show a place that sells something handmade', { type: 'shopping' }),
];

// ===================== WEEKLY CHALLENGE IDEAS (40) =====================
const WEEKLY = [
  // Multi-Stop Food (10)
  ch('Coffee Shop Crawl', 'Visit 3 different coffee shops in one week', { type: 'food', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Cuisine Quest', 'Try 3 different cuisines', { type: 'food', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('3 Meal 3 Places', 'Snap breakfast, lunch, and dinner from 3 different places', { type: 'food', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Best Dessert In Your Area', 'Find the best dessert spot in your area', { type: 'food', frequency: 'WEEKLY', difficulty: 'MEDIUM' }),
  ch('Two New Local Spots', 'Visit 2 local restaurants you have never tried before', { type: 'food', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 2 }),
  ch('3 Drinks 3 Places', 'Snap 3 different drinks from 3 different places', { type: 'food', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Two Food Trucks', 'Try food from 2 food trucks', { type: 'food', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 2 }),
  ch('Restaurant In A New Neighborhood', 'Visit a restaurant in a new neighborhood', { type: 'food', frequency: 'WEEKLY', difficulty: 'MEDIUM' }),
  ch('City Best: Burger, Pizza, or Taco', 'Find your city best burger, pizza, or taco', { type: 'food', frequency: 'WEEKLY', difficulty: 'MEDIUM' }),
  ch('Perfect Food Day', 'Create a "perfect food day" with 3 different stops', { type: 'food', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),

  // Exploration (10)
  ch('3 Different Neighborhoods', 'Visit 3 different neighborhoods', { type: 'city', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('5 City Landmarks', 'Snap 5 landmarks in your city', { type: 'city', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 5 }),
  ch('3 Hidden Gems', 'Find 3 hidden gems', { type: 'city', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Park, Cafe, Restaurant', 'Visit a park, cafe, and restaurant in the same week', { type: 'city', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('3 Great Views', 'Show 3 places with great views', { type: 'outdoors', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('3 Murals or Street Art', 'Snap 3 different murals or street art pieces', { type: 'art', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('2 New Places', 'Visit 2 places you have never been before', { type: 'city', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 2 }),
  ch('3 Photo-Worthy Spots', 'Find 3 photo-worthy spots', { type: 'city', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('3 Architecture Types', 'Snap 3 different types of architecture', { type: 'city', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Mini City Tour', 'Create a mini city tour using 5 photos', { type: 'city', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 5 }),

  // Social & Lifestyle (9 — skipped "Go out with friends" which needs friend flow)
  ch('Weekend In 5 Photos', 'Show your weekend in 5 photos', { type: 'social', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 5 }),
  ch('3 Recommended Places', 'Visit 3 places you would recommend to a friend', { type: 'social', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Food, Fitness, Fun', 'Snap 3 activities: food, fitness, and fun', { type: 'social', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Full Day Outside', 'Show a full day outside your home', { type: 'social', frequency: 'WEEKLY', difficulty: 'MEDIUM' }),
  ch('Productive Place', 'Find a place that makes you feel productive', { type: 'social', frequency: 'WEEKLY', difficulty: 'MEDIUM' }),
  ch('Place You Used To Go', 'Visit a place you used to go often but haven\'t been recently', { type: 'social', frequency: 'WEEKLY', difficulty: 'MEDIUM' }),
  ch('Favorite Hangout Area', 'Show your favorite hangout area', { type: 'social', frequency: 'WEEKLY', difficulty: 'MEDIUM' }),
  ch('3 Good Vibe Places', 'Snap 3 places with good vibes', { type: 'social', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Ideal Sunday', 'Create your "ideal Sunday" with 3 stops', { type: 'social', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),

  // Fitness & Outdoor (10)
  ch('10,000 Steps Tour', 'Walk 10,000 steps and snap 3 places along the way', { type: 'fitness', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('3 Parks In A Week', 'Visit 3 parks in one week', { type: 'outdoors', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('3 Sports Activities', 'Find 3 different sports or fitness activities happening nearby', { type: 'fitness', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Sunrise/Sunset Plus Activity', 'Snap a sunrise or sunset plus one outdoor activity', { type: 'outdoors', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 2 }),
  ch('Gym, Park, Healthy Food', 'Visit a gym, park, and healthy food spot', { type: 'fitness', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('3 Ways To Stay Active', 'Show 3 ways people stay active in your city', { type: 'fitness', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Scenic Walk 5 Stops', 'Complete a scenic walk and document 5 stops', { type: 'outdoors', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 5 }),
  ch('Court, Field, Running Path', 'Find a basketball court, soccer field, and running path', { type: 'fitness', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('3 Outdoor Workout Spots', 'Snap 3 outdoor workout locations', { type: 'fitness', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Best Active Day', 'Show your best active day', { type: 'fitness', frequency: 'WEEKLY', difficulty: 'MEDIUM' }),
];

// ===================== WEEKEND CHALLENGES (14) =====================
const WEEKEND = [
  ch('Saturday Brunch', 'Show your Saturday brunch', { type: 'weekend', weekendOnly: true }),
  ch('Weekend Market', 'Visit a weekend market', { type: 'weekend', weekendOnly: true }),
  ch('Best Weekend View', 'Show your best weekend view', { type: 'weekend', weekendOnly: true }),
  ch('Live Music or Public Event', 'Find live music or a public event', { type: 'weekend', weekendOnly: true, difficulty: 'MEDIUM' }),
  ch('Sunday Coffee', 'Snap your Sunday coffee', { type: 'weekend', weekendOnly: true }),
  ch('Relaxing Weekend Spot', 'Show a place that feels relaxing', { type: 'weekend', weekendOnly: true }),
  ch('New Weekend Restaurant', 'Try one new restaurant this weekend', { type: 'weekend', weekendOnly: true, difficulty: 'MEDIUM' }),
  ch('Fun Weekend Activity', 'Snap a fun activity with friends', { type: 'weekend', weekendOnly: true }),
  ch('Weekend Dessert', 'Show your weekend dessert', { type: 'weekend', weekendOnly: true }),
  ch('Weekend Park Visit', 'Visit a local park', { type: 'weekend', weekendOnly: true }),
  ch('Weekend Energy', 'Find a place with weekend energy', { type: 'weekend', weekendOnly: true }),
  ch('Late-Night Food Spot', 'Show your favorite late-night food spot', { type: 'weekend', weekendOnly: true }),
  ch('Weekend Date Recommendation', 'Snap a place you would recommend for a date', { type: 'weekend', weekendOnly: true }),
  ch('Weekend Recap', 'Create a 3-photo weekend recap', { type: 'weekend', weekendOnly: true, difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
];

// ===================== SEASONAL CHALLENGES (40) =====================
const SEASONAL = [
  // Summer (10)
  ch('Favorite Ice Cream Spot', 'Snap your favorite ice cream spot', { type: 'seasonal', season: 'summer' }),
  ch('Beach, Pool, or Waterfront View', 'Show a beach, pool, or waterfront view', { type: 'seasonal', season: 'summer' }),
  ch('Outdoor Dining', 'Find outdoor dining', { type: 'seasonal', season: 'summer' }),
  ch('Best Summer Sunset', 'Snap the best summer sunset', { type: 'seasonal', season: 'summer' }),
  ch('Summer Drink', 'Show a summer drink', { type: 'seasonal', season: 'summer' }),
  ch('Summer Farmers Market', 'Visit a farmers market', { type: 'seasonal', season: 'summer' }),
  ch('Picnic Setup', 'Snap a picnic setup', { type: 'seasonal', season: 'summer' }),
  ch('Outdoor Sports', 'Show people playing outdoor sports', { type: 'seasonal', season: 'summer' }),
  ch('Rooftop or Patio', 'Find a rooftop or patio spot', { type: 'seasonal', season: 'summer' }),
  ch('Best Summer Day', 'Show your best summer day', { type: 'seasonal', season: 'summer' }),

  // Fall (10)
  ch('Fall Leaves', 'Snap fall leaves', { type: 'seasonal', season: 'fall' }),
  ch('Cozy Fall Cafe', 'Show your favorite cozy cafe', { type: 'seasonal', season: 'fall' }),
  ch('Pumpkin-Themed Item', 'Find a pumpkin-themed item', { type: 'seasonal', season: 'fall' }),
  ch('Fall Dessert', 'Snap a fall dessert', { type: 'seasonal', season: 'fall' }),
  ch('Peak Fall Colors', 'Visit a park during peak fall colors', { type: 'seasonal', season: 'fall' }),
  ch('Warm Drink', 'Show a warm drink', { type: 'seasonal', season: 'fall' }),
  ch('Halloween Decoration', 'Find a Halloween decoration', { type: 'seasonal', season: 'fall' }),
  ch('Fall Bookstore or Study Spot', 'Snap a bookstore or study spot', { type: 'seasonal', season: 'fall' }),
  ch('Fall Outfit Spot', 'Show a fall outfit in a cool location', { type: 'seasonal', season: 'fall' }),
  ch('Fall Seasonal Menu Item', 'Find a seasonal menu item', { type: 'seasonal', season: 'fall' }),

  // Winter (10)
  ch('Holiday Lights', 'Snap holiday lights', { type: 'seasonal', season: 'winter' }),
  ch('Hot Chocolate', 'Show your favorite hot chocolate', { type: 'seasonal', season: 'winter' }),
  ch('Cozy Indoor Spot', 'Find a cozy indoor spot', { type: 'seasonal', season: 'winter' }),
  ch('Winter View', 'Snap a winter view', { type: 'seasonal', season: 'winter' }),
  ch('Comfort Food Meal', 'Show a soup, ramen, or comfort food meal', { type: 'seasonal', season: 'winter' }),
  ch('Decorated Storefront', 'Find a decorated storefront', { type: 'seasonal', season: 'winter' }),
  ch('Ice Skating or Winter Activity', 'Snap ice skating or winter activity', { type: 'seasonal', season: 'winter' }),
  ch('Favorite Indoor Hangout', 'Show your favorite indoor hangout', { type: 'seasonal', season: 'winter' }),
  ch('Warm Drink Spot', 'Find a warm drink spot', { type: 'seasonal', season: 'winter' }),
  ch('Snowy Street or Winter Scene', 'Snap a snowy street or winter scene', { type: 'seasonal', season: 'winter' }),

  // Spring (10)
  ch('Flowers Blooming', 'Snap flowers blooming', { type: 'seasonal', season: 'spring' }),
  ch('Favorite Outdoor Cafe', 'Show your favorite outdoor cafe', { type: 'seasonal', season: 'spring' }),
  ch('Colorful Garden', 'Find a colorful garden', { type: 'seasonal', season: 'spring' }),
  ch('Sunny Walk', 'Snap a sunny walk', { type: 'seasonal', season: 'spring' }),
  ch('Fresh Drink or Smoothie', 'Show a fresh drink or smoothie', { type: 'seasonal', season: 'spring' }),
  ch('Spring Park Visit', 'Visit a park', { type: 'seasonal', season: 'spring' }),
  ch('Spring Dessert', 'Find a spring dessert', { type: 'seasonal', season: 'spring' }),
  ch('Outdoor Seating People', 'Snap people enjoying outdoor seating', { type: 'seasonal', season: 'spring' }),
  ch('Refreshed Place', 'Show a place that feels refreshed', { type: 'seasonal', season: 'spring' }),
  ch('Best Spring View', 'Find the best spring view', { type: 'seasonal', season: 'spring' }),
];

// ===================== HIGHER-VALUE BONUS (15) =====================
const BONUS = [
  ch('5 New Places In A Week', 'Visit 5 new places in one week', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 5 }),
  ch('Full Food Crawl', 'Complete a full food crawl with 4 stops', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 4 }),
  ch('10 City Landmarks', 'Snap 10 different city landmarks', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 10 }),
  ch('5 Cuisine Types', 'Show 5 different types of cuisine', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 5 }),
  ch('3 Small Businesses In A Day', 'Visit 3 small businesses in one day', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Hidden Gems Collection', 'Create a "hidden gems" collection with 5 spots', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 5 }),
  ch('Sunrise And Sunset Same Day', 'Snap sunrise and sunset on the same day', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 2 }),
  ch('3 Parks In 48 Hours', 'Visit 3 parks in 48 hours', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('City Through 7 Photos', 'Show your city through 7 photos', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 7 }),
  ch('5 Places Under $10', 'Find 5 places under $10', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 5 }),
  ch('Restaurant, Cafe, Park, Shop', 'Visit a restaurant, cafe, park, and local shop in one day', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 4 }),
  ch('5 Different Murals', 'Snap 5 different murals', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 5 }),
  ch('3 Live Energy Places', 'Show 3 places with live energy: music, sports, crowds, or events', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Neighborhood Tour 5 Stops', 'Complete a neighborhood tour with 5 stops', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 5 }),
  ch('Unknown To Friends', 'Find 3 places your friends have never heard of', { type: 'bonus', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
];

// ===================== BRAND-NAMED FLAVOR (19) =====================
const BRAND = [
  ch('Breakfast Blitz', 'Show your breakfast', { type: 'brand' }),
  ch('Sunset Snap-Off', 'Snap your best sunset', { type: 'brand' }),
  ch('Street Art Sprint', 'Find 3 pieces of street art', { type: 'brand', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Coffee Crawl Daily', 'Show your favorite coffee shop', { type: 'brand' }),
  ch('Donut Drop', 'Snap your favorite donut', { type: 'brand' }),
  ch('Active Spotting', 'Show a public activity scene', { type: 'brand' }),
  ch('Hidden Gem Hunt', 'Find a place most people do not know', { type: 'brand', difficulty: 'MEDIUM' }),
  ch('View Victory', 'Capture the best view nearby', { type: 'brand' }),
  ch('Local Legend', 'Show a small business you love', { type: 'brand' }),
  ch('Snack Attack', 'Snap your favorite snack', { type: 'brand' }),
  ch('Park Points', 'Visit a local park', { type: 'brand' }),
  ch('Brunch Battle', 'Show your best brunch', { type: 'brand' }),
  ch('Weekend Warrior', 'Complete 3 weekend spots', { type: 'brand', frequency: 'WEEKLY', weekendOnly: true, difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('OutSpot Original', 'Visit a place you have never been', { type: 'brand', difficulty: 'MEDIUM' }),
  ch('Flavor Finder', 'Try something new', { type: 'brand', difficulty: 'MEDIUM' }),
  ch('City Scout', 'Snap a cool city location', { type: 'brand' }),
  ch('Sweet Spot', 'Show your favorite dessert', { type: 'brand' }),
  ch('Cuisine Quest Daily', 'Visit a new cuisine restaurant', { type: 'brand', difficulty: 'MEDIUM' }),
  ch('Mural Mission Spot', 'Snap a mural', { type: 'brand' }),
];

// ===================== HEALTH & WELLNESS DAILY (45) =====================
const HEALTH_DAILY = [
  // Daily Health (20)
  ch('Morning Walk Snap', 'Take a walk and snap something interesting along the way', { type: 'health' }),
  ch('Hydration Check', 'Show your water bottle at a cool spot', { type: 'health' }),
  ch('Healthy Plate', 'Snap a balanced meal', { type: 'health' }),
  ch('Fruit Find', 'Show your favorite fruit or fruit bowl', { type: 'health' }),
  ch('Smoothie Spot', 'Find a smoothie or juice bar', { type: 'health' }),
  ch('Green Meal Challenge', 'Snap a meal with something green in it', { type: 'health' }),
  ch('Outdoor Stretch', 'Show a park or place where you would stretch', { type: 'health' }),
  ch('Steps Challenge', 'Walk to a new place and snap your destination', { type: 'health' }),
  ch('Fresh Air Break', 'Step outside and capture your view', { type: 'health' }),
  ch('Healthy Snack Hunt', 'Show a healthy snack from a cafe, store, or home', { type: 'health' }),
  ch('Workout Spot', 'Snap your gym, court, field, or outdoor workout area', { type: 'health', difficulty: 'MEDIUM' }),
  ch('Mindful Moment', 'Show a peaceful place where you can relax', { type: 'health' }),
  ch('Sleep Reset', 'Snap your calm evening routine setup', { type: 'health' }),
  ch('No Elevator Challenge', 'Take the stairs and snap the staircase', { type: 'health' }),
  ch('Protein Pick', 'Show a protein-focused meal or snack', { type: 'health' }),
  ch('Nature Break', 'Visit a park, trail, garden, or waterfront', { type: 'health' }),
  ch('Post-Workout Fuel', 'Snap your meal or drink after exercise', { type: 'health', difficulty: 'MEDIUM' }),
  ch('Healthy Swap', 'Show a healthier version of something you usually eat', { type: 'health' }),
  ch('Sunlight Snap', 'Go outside and capture natural sunlight', { type: 'health' }),
  ch('Digital Detox Spot', 'Show a place where you would put your phone away and relax', { type: 'health' }),

  // Fitness & Movement (15)
  ch('10-Minute Walk', 'Walk for 10 minutes and snap your favorite thing you saw', { type: 'fitness_health' }),
  ch('Park Workout', 'Find a park with space to move', { type: 'fitness_health', difficulty: 'MEDIUM' }),
  ch('Court Check', 'Snap a basketball, tennis, soccer, or volleyball court', { type: 'fitness_health' }),
  ch('Bike Route', 'Show a bike lane, bike rack, or biking trail', { type: 'fitness_health' }),
  ch('Run Route', 'Capture a running path or trail', { type: 'fitness_health', difficulty: 'MEDIUM' }),
  ch('Gym Grind', 'Snap your gym entrance or workout setup', { type: 'fitness_health', difficulty: 'MEDIUM' }),
  ch('Active Commute', 'Walk or bike somewhere instead of driving', { type: 'fitness_health', difficulty: 'MEDIUM' }),
  ch('Stair Climb', 'Find a big staircase and snap it', { type: 'fitness_health' }),
  ch('Outdoor Game', 'Show a public sports field or court', { type: 'fitness_health' }),
  ch('Fitness Class Find', 'Snap a yoga, boxing, pilates, dance, or spin studio', { type: 'fitness_health', difficulty: 'MEDIUM' }),
  ch('Stretch Zone', 'Find a peaceful spot to stretch', { type: 'fitness_health' }),
  ch('Sweat Then Snack', 'Do a workout and snap a healthy snack after', { type: 'fitness_health', difficulty: 'MULTI_STEP', requiredPhotos: 2 }),
  ch('Weekend Walkabout', 'Take a long walk and capture 3 stops', { type: 'fitness_health', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('One-Mile Mission', 'Walk or run one mile and snap the finish spot', { type: 'fitness_health', difficulty: 'MEDIUM' }),
  ch('Move Before Meal', 'Take a walk before eating out', { type: 'fitness_health' }),

  // Mental Health (10)
  ch('Peaceful Place', 'Snap a calm place nearby', { type: 'mental_health' }),
  ch('Quiet Corner', 'Find a quiet coffee shop, park bench, library, or bookstore', { type: 'mental_health' }),
  ch('Gratitude Snap', 'Capture one thing that made you happy today', { type: 'mental_health' }),
  ch('Golden Hour Reset', 'Go outside during golden hour', { type: 'mental_health' }),
  ch('Nature Therapy', 'Show trees, flowers, water, or sky', { type: 'mental_health' }),
  ch('Book Break', 'Snap a reading spot', { type: 'mental_health' }),
  ch('Solo Recharge', 'Show a place where you can recharge', { type: 'mental_health' }),
  ch('Calm Cafe', 'Find a cozy cafe with relaxing vibes', { type: 'mental_health' }),
  ch('Screen-Free Spot', 'Show a place you would enjoy without scrolling', { type: 'mental_health' }),
  ch('Fresh Start', 'Snap something that makes your day feel reset', { type: 'mental_health' }),
];

// ===================== WEEKLY HEALTH (15) =====================
const HEALTH_WEEKLY = [
  ch('3-Day Walk Streak', 'Take a walk on 3 different days', { type: 'health', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Healthy Food Crawl', 'Visit 3 healthy food spots in one week', { type: 'health', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Park Trio', 'Visit 3 different parks', { type: 'health', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Fitness Explorer', 'Find a gym, court, and trail', { type: 'health', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Smoothie Week', 'Try 2 different smoothie or juice spots', { type: 'health', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 2 }),
  ch('Active Weekend', 'Complete 2 outdoor activities over the weekend', { type: 'health', frequency: 'WEEKLY', weekendOnly: true, difficulty: 'MULTI_STEP', requiredPhotos: 2 }),
  ch('Wellness Tour', 'Visit a cafe, park, fitness spot, and healthy restaurant', { type: 'health', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 4 }),
  ch('Step-Up Week', 'Walk to 3 places you would usually drive or Uber to', { type: 'health', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Mindful Week', 'Capture 3 peaceful places in your city', { type: 'health', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('New Healthy Spot', 'Try one new healthy restaurant or cafe', { type: 'health', frequency: 'WEEKLY', difficulty: 'MEDIUM' }),
  ch('Sunrise or Sunset Walk', 'Walk during sunrise or sunset', { type: 'health', frequency: 'WEEKLY', difficulty: 'MEDIUM' }),
  ch('Outdoor Hour', 'Spend one hour outside and snap 3 moments', { type: 'health', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Fitness Class Challenge', 'Try or visit a new fitness class', { type: 'health', frequency: 'WEEKLY', difficulty: 'MEDIUM' }),
  ch('Healthy Breakfast Week', 'Snap 3 healthy breakfasts', { type: 'health', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
  ch('Hydration Hero', 'Show your water bottle at 3 different places', { type: 'health', frequency: 'WEEKLY', difficulty: 'MULTI_STEP', requiredPhotos: 3 }),
];

// ===================== RUN UPSERTS =====================
async function main() {
  const all = [
    ...DAILY,
    ...WEEKLY,
    ...WEEKEND,
    ...SEASONAL,
    ...BONUS,
    ...BRAND,
    ...HEALTH_DAILY,
    ...HEALTH_WEEKLY,
  ];

  // Cross-bucket duplicate guard — the DB unique key is [title, frequency], so
  // two entries with the same (title, freq) would conflict on the second upsert.
  const seen = new Set();
  for (const c of all) {
    const k = `${c.title}|${c.frequency}`;
    if (seen.has(k)) {
      console.error(`✗ duplicate (title, frequency): ${k}`);
      process.exit(1);
    }
    seen.add(k);
  }

  let inserted = 0, updated = 0;
  for (const data of all) {
    const existing = await prisma.challenge.findUnique({
      where: { title_frequency: { title: data.title, frequency: data.frequency } },
    });
    if (existing) {
      await prisma.challenge.update({
        where: { id: existing.id },
        data: {
          description: data.description,
          type: data.type,
          points: data.points,
          tier: data.tier,
          requiredPhotos: data.requiredPhotos,
          weekendOnly: data.weekendOnly,
          season: data.season,
          difficulty: data.difficulty,
          isActive: data.isActive,
          isFeatured: data.isFeatured,
        },
      });
      updated++;
    } else {
      await prisma.challenge.create({ data });
      inserted++;
    }
  }

  // Summary
  const byFreq = await prisma.challenge.groupBy({ by: ['frequency'], _count: { _all: true } });
  const byDiff = await prisma.challenge.groupBy({ by: ['difficulty'], _count: { _all: true } });
  const weekendCount = await prisma.challenge.count({ where: { weekendOnly: true } });
  const seasonalCount = await prisma.challenge.count({ where: { season: { not: null } } });

  console.log(`✅ seed complete  inserted=${inserted}  updated=${updated}  total considered=${all.length}`);
  console.log(`\nDB totals after seed:`);
  console.log(`  By frequency:`, byFreq.map(r => `${r.frequency}=${r._count._all}`).join('  '));
  console.log(`  By difficulty:`, byDiff.map(r => `${r.difficulty || 'NULL'}=${r._count._all}`).join('  '));
  console.log(`  weekendOnly:`, weekendCount);
  console.log(`  seasonal:`, seasonalCount);
}

main()
  .catch(e => { console.error('seed crashed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
