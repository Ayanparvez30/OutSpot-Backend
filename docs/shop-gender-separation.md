# Shop Gender Separation

## Overview

Every shop item now belongs to a gender (`masculine` or `feminine`). Onboarding, shop, and wardrobe are fully separated by gender. Existing null-gender items remain in the database but are hidden from catalog APIs until reassigned via admin.

---

## Gender → Category Mapping

| Gender | Allowed Categories (Slots) |
|--------|---------------------------|
| **Masculine** | TOP, BOTTOM, SHOES, GLASSES, WATCH |
| **Feminine** | TOP, BOTTOM, SHOES, GLASSES, WATCH, PURSE (bag), ORNAMENT (necklace), MAKEUP (lipstick) |

---

## Admin Panel Changes

### Create / Edit Item Form (`/admin/shop/create`, `/admin/shop/:id/edit`)

- **Gender selector** added above the category dropdown (Masculine / Feminine, required).
- **Category (Slot) dropdown** is dynamically populated by client-side JS based on selected gender.
  - Switching gender resets the slot list to only the gender's allowed categories.
  - On edit, existing slot is preserved and pre-selected automatically.
  - Legacy `ACCESSORY` slot items: displayed as `ACCESSORY (legacy)` when editing — admin can migrate to a valid slot.
- **Validation**: if submitted slot is not in the gender's allowed list, form redirects with error flash message. `ACCESSORY` is exempt to allow legacy edits.

### Item List (`/admin/shop`)

- **Gender filter pills** added: All genders / Masculine / Feminine.
- **Gender column** added to table showing badge: `Masculine` (blue), `Feminine` (red), `—` (legacy/null).
- Slot filter and gender filter compose — both apply simultaneously.
- Search preserves active gender and slot filters.

---

## API Changes

### Onboarding — Free Items
```
GET /api/shop/catalog/free?gender=masculine|feminine
```
- `gender` query param **required** (was optional before).
- Filters by `ShopItem.gender` column (was filtering by slot list).
- Returns only free items (no IAP IDs) for the requested gender.
- Response includes `gender` field on each item.

**Breaking change:** calls without `?gender=` now return `400`.

### Shop — Paid Items
```
GET /api/shop/catalog/paid?gender=masculine|feminine
```
- `gender` query param **required** (was optional before).
- Filters by `ShopItem.gender` column.
- Returns only paid items (at least one IAP ID set) for the requested gender.
- Response includes `gender` field on each item.

**Breaking change:** calls without `?gender=` now return `400`.

### Full Catalog
```
GET /api/shop/catalog?gender=masculine|feminine
```
- `gender` query param **required** (was optional before).

**Breaking change:** calls without `?gender=` now return `400`.

### Wardrobe — No Change
```
GET /api/shop/wardrobe
```
- Returns all purchased items for the user regardless of gender.
- Ownership overrides gender — once bought, always visible.

---

## Error Response (missing/invalid gender)

```json
{
  "success": false,
  "message": "gender query param required (masculine|feminine)"
}
```
HTTP status: `400`

---

## Backend Changes

### `controllers/admin/adminShopController.js`
- Added `GENDER_SLOTS` map.
- `createItem`: requires `gender`, validates slot against `GENDER_SLOTS[gender]`.
- `updateItem`: same validation; `ACCESSORY` slot bypasses check for legacy compatibility.
- `listItems`: supports `?gender=` filter for admin list page.

### `controllers/shopController.js`
- `getCatalog`, `getCatalogFree`, `getCatalogPaid`: all now require `gender`, filter by `ShopItem.gender` column instead of slot list.
- `MASCULINE_SLOTS` / `FEMININE_SLOTS` constants kept (used in tests).
- `getWardrobeInventory`: **unchanged**.

### Schema
No migration required. `ShopItem.gender` field already existed (`String?`). Null rows are legacy — hidden from catalog APIs, still editable in admin.

---

## Data Migration (optional)

Run SQL to assign gender to existing untagged rows:

```sql
-- Clear obvious ones by slot
UPDATE ShopItem SET gender = 'masculine' WHERE gender IS NULL AND slot = 'WATCH';
UPDATE ShopItem SET gender = 'feminine'  WHERE gender IS NULL AND slot IN ('MAKEUP', 'PURSE', 'ORNAMENT');

-- TOP / BOTTOM / SHOES / GLASSES rows need manual gender assignment via admin edit.
```

---

## Flutter Integration

Pass `?gender=masculine` or `?gender=feminine` on every catalog call. Derive gender from the logged-in user's profile. Wardrobe call requires no change.

See Flutter models and service layer in the API documentation section.
