// Campus constants from the README (section 6).
export const TARIFF_RS_PER_KWH = 8;
export const CO2_KG_PER_KWH = 0.7;
export const WATER_KWH_PER_L = 0.85 / 1000;
export const COMPOST_RATIO = 4; // 4 kg wet organic -> 1 kg compost
export const BAG_KG = 8;

export const CREDIT_SHARE = 0.3; // share of verified savings returned to the building fund
export const MIN_COVERAGE = 0.9; // below this, a building earns no credits that week
export const MANUAL_SORT_BELOW = 0.6; // classifier confidence threshold (matches P2's not_sure_threshold)

export type Stream = 'electricity' | 'water';

export const STREAM_META: Record<Stream, { label: string; unit: string; key: 'electricity_kwh' | 'water_litres' }> = {
  electricity: { label: 'Electricity', unit: 'kWh', key: 'electricity_kwh' },
  water: { label: 'Water', unit: 'L', key: 'water_litres' },
};

export const SHORT_NAME: Record<string, string> = {
  B01: 'Academic A',
  B02: 'Academic B',
  B03: 'Library',
  B04: 'Eng. Labs',
  B05: 'Boys Hostel',
  B06: 'Girls Hostel',
  B07: 'Food Court',
  B08: 'Admin',
};

export const BUILDING_SPRITE: Record<string, string> = {
  B01: 'bld_academic',
  B02: 'bld_academic',
  B03: 'bld_library',
  B04: 'bld_labs',
  B05: 'bld_hostel_boys',
  B06: 'bld_hostel_girls',
  B07: 'bld_foodcourt',
  B08: 'bld_admin',
};

export const WASTE_CLASSES = ['food_organic', 'paper_cardboard', 'plastic', 'glass', 'metal', 'ewaste'] as const;
export type WasteClass = (typeof WASTE_CLASSES)[number];

export const WASTE_META: Record<WasteClass, { label: string; sprite: string; bin: string }> = {
  food_organic: { label: 'Food / organic', sprite: 'item_food', bin: 'Composter' },
  paper_cardboard: { label: 'Paper / card', sprite: 'item_paper', bin: 'Dry recycling' },
  plastic: { label: 'Plastic', sprite: 'item_plastic', bin: 'Dry recycling' },
  glass: { label: 'Glass', sprite: 'item_glass', bin: 'Glass bank' },
  metal: { label: 'Metal', sprite: 'item_metal', bin: 'Metal scrap' },
  ewaste: { label: 'E-waste', sprite: 'item_ewaste', bin: 'E-waste vault' },
};

export const kwhToRs = (kwh: number) => kwh * TARIFF_RS_PER_KWH;
export const kwhToCo2 = (kwh: number) => kwh * CO2_KG_PER_KWH;
export const waterToKwh = (litres: number) => litres * WATER_KWH_PER_L;
