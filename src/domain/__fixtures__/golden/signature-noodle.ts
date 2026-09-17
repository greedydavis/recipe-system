/**
 * 黃金範例（虛構資料）：docs/SPEC.md §3.4 的手算範例。
 * 期望值由手算與 Python decimal 驗算得出；要修改期望值必須先取得使用者同意。
 */
import { bundle, compLine, ingLine, ingredient, version } from '../builders';

export const ingredients = {
  bone: ingredient({ name: '豬大骨', base: 'mass', spec: { qty: 20, unit: 'kg', price: 1200 } }),
  onion: ingredient({ name: '洋蔥', base: 'mass', waste: 0.1, spec: { qty: 20, unit: 'kg', price: 500 } }),
  water: ingredient({ name: '水', base: 'volume', density: 1, spec: { qty: 1000, unit: 'L', price: 12 } }),
  noodle: ingredient({ name: '生麵條', base: 'mass', spec: { qty: 3, unit: 'kg', price: 180 } }),
  scallion: ingredient({ name: '青蔥', base: 'mass', waste: 0.2, spec: { qty: 3, unit: 'kg', price: 270 } }),
  egg: ingredient({
    name: '雞蛋',
    base: 'mass',
    units: [{ unit_name: '顆', qty_in_base: 60 }],
    spec: { qty: 1, unit: '台斤', price: 40 },
  }),
};

export const soup = version({
  name: '招牌湯底',
  type: 'component',
  batch: [21000, 'g'],
  serving: [420, 'g'],
  lines: [
    ingLine(ingredients.bone, 10000, 'g'),
    ingLine(ingredients.onion, 2000, 'g'),
    ingLine(ingredients.water, 30, 'L'),
  ],
});

export const dish = version({
  name: '招牌湯麵',
  type: 'dish',
  serving: [640, 'g'],
  menuPrice: 90,
  lines: [
    compLine(soup, 420, 'g'),
    ingLine(ingredients.noodle, 150, 'g'),
    ingLine(ingredients.scallion, 10, 'g'),
    ingLine(ingredients.egg, 1, '顆'),
  ],
});

export const goldenBundle = bundle([soup, dish], Object.values(ingredients));

/** 比較到小數 10 位（循環小數無法用有限位數表示） */
export const expected = {
  unitCost: {
    bone: '0.0600000000',
    onion: '0.0250000000',
    water: '0.0000120000',
    noodle: '0.0600000000',
    scallion: '0.0900000000',
    egg: '0.0666666667',
  },
  soup: {
    lineCosts: ['600.0000000000', '55.5555555556', '0.3600000000'],
    onionPurchaseQty: '2222.2222222222',
    batchCost: '655.9155555556',
    inputWeightG: '42000.0000000000',
    yieldRate: '0.5000000000',
    servingsPerBatch: '50.0000000000',
    servingCost: '13.1183111111',
  },
  dish: {
    lineCosts: ['13.1183111111', '9.0000000000', '1.1250000000', '4.0000000000'],
    servingCost: '27.2433111111',
    netPrice: '85.7142857143',
    foodCostRate: '0.3178386296',
    grossMarginRate: '0.6821613704',
    suggestedPrice: '85',
  },
  display: {
    soupServingCost: '13.1',
    soupBatchCost: '656',
    dishServingCost: '27.2',
    foodCostRate: '31.8%',
    grossMarginRate: '68.2%',
  },
};
