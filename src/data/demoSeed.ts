import { computeVersionCost } from '../domain/costing';
import { priceMetrics } from '../domain/pricing';
import { buildSnapshot } from '../domain/snapshot';
import type { CostingBundle, Role } from '../domain/types';

interface SeedApi {
  createUser(email: string, displayName: string): Promise<string>;
  setRole(id: string, role: Role): Promise<void>;
  rpcAs<T>(userId: string | null, fn: string, args?: Record<string, unknown>): Promise<T>;
}

const uuid = () => crypto.randomUUID();

/** 示範模式的虛構資料（對應 docs/SPEC.md §3.4 的黃金範例）；不是真實配方 */
export async function seedDemoData(api: SeedApi): Promise<void> {
  const founder = await api.createUser('founder@demo.local', '示範創辦人');
  const chef = await api.createUser('chef@demo.local', '示範主廚');
  const manager = await api.createUser('manager@demo.local', '示範店長');
  const tester1 = await api.createUser('tester1@demo.local', '示範試吃員甲');
  const tester2 = await api.createUser('tester2@demo.local', '示範試吃員乙');
  await api.setRole(chef, 'chef');
  await api.setRole(manager, 'manager');
  await api.setRole(tester1, 'tester');
  await api.setRole(tester2, 'tester');

  const asChef = <T>(fn: string, args?: Record<string, unknown>) => api.rpcAs<T>(chef, fn, args);

  const market = await asChef<string>('upsert_supplier', { p: { name: '示範傳統市場', note: '虛構資料' } });
  const meat = await asChef<string>('upsert_supplier', { p: { name: '示範肉品行', contact_name: '王先生', phone: '04-0000-0000' } });

  async function ingredient(
    name: string,
    base: 'mass' | 'volume',
    category: string,
    spec: { qty: number; unit: string; price: number; supplier?: string },
    extra: { waste?: number; density?: number } = {},
  ) {
    const id = await asChef<string>('upsert_ingredient', {
      p: {
        name,
        base_dimension: base,
        category,
        default_waste_rate: extra.waste ?? 0,
        density_g_per_ml: extra.density ?? '',
      },
    });
    const specId = await asChef<string>('upsert_packaging_spec', {
      p: {
        ingredient_id: id,
        supplier_id: spec.supplier ?? market,
        spec_name: `${spec.qty} ${spec.unit}`,
        pack_qty: spec.qty,
        pack_unit: spec.unit,
      },
    });
    await asChef('add_purchase_price', { p_spec_id: specId, p_price: spec.price, p_effective_date: '2026-09-01', p_note: '示範報價' });
    return id;
  }

  const bone = await ingredient('豬大骨（示範）', 'mass', 'meat', { qty: 20, unit: 'kg', price: 1200, supplier: meat });
  const onion = await ingredient('洋蔥（示範）', 'mass', 'produce', { qty: 20, unit: 'kg', price: 500 }, { waste: 0.1 });
  const water = await ingredient('水（示範）', 'volume', 'other', { qty: 1000, unit: 'L', price: 12 }, { density: 1 });
  const noodle = await ingredient('生麵條（示範）', 'mass', 'grain', { qty: 3, unit: 'kg', price: 180 });
  const scallion = await ingredient('青蔥（示範）', 'mass', 'produce', { qty: 3, unit: 'kg', price: 270 }, { waste: 0.2 });
  const egg = await asChef<string>('upsert_ingredient', { p: { name: '雞蛋（示範）', base_dimension: 'mass', category: 'egg_soy_dairy' } });
  await asChef('upsert_ingredient_unit', { p: { ingredient_id: egg, unit_name: '顆', qty_in_base: 60 } });
  const eggSpec = await asChef<string>('upsert_packaging_spec', {
    p: { ingredient_id: egg, supplier_id: market, spec_name: '1 台斤', pack_qty: 1, pack_unit: '台斤' },
  });
  await asChef('add_purchase_price', { p_spec_id: eggSpec, p_price: 40, p_effective_date: '2026-09-01', p_note: '示範報價' });

  // 元件：招牌湯底
  const soup = await asChef<{ recipe_id: string; version_id: string }>('create_recipe', {
    p: { type: 'component', component_kind: 'soup', name: '招牌湯底（示範）', description: '虛構的示範資料' },
  });
  await asChef('save_version_draft', {
    p_version_id: soup.version_id,
    p_revision: 1,
    p: {
      title: '第一版',
      batch_output_qty: 21000,
      batch_output_unit: 'g',
      serving_qty: 420,
      serving_unit: 'g',
      storage_method: '快速冷卻後冷藏 0–5°C，密封標示日期',
      shelf_life_hours: 48,
      lines: [
        { id: uuid(), line_kind: 'ingredient', ingredient_id: bone, quantity: 10000, unit: 'g', prep_note: '汆燙去血水' },
        { id: uuid(), line_kind: 'ingredient', ingredient_id: onion, quantity: 2000, unit: 'g', prep_note: '去皮切塊' },
        { id: uuid(), line_kind: 'ingredient', ingredient_id: water, quantity: 30, unit: 'L' },
      ],
      steps: [
        { id: uuid(), instruction: '大骨冷水下鍋汆燙，撈出沖淨。', duration_minutes: 10, heat_level: 'high' },
        { id: uuid(), instruction: '大骨、洋蔥與水入鍋，煮滾後轉小火，持續撇沫。', duration_minutes: 240, heat_level: 'simmer' },
        {
          id: uuid(),
          instruction: '細網過濾，秤重記錄成品量，立即冷卻。',
          temperature_c: 5,
          is_critical: true,
          critical_note: '2 小時內降至 21°C 以下，再 4 小時內降至 5°C 以下',
        },
      ],
    },
  });
  await asChef('transition_version', { p_version_id: soup.version_id, p_to: 'testing', p_comment: '' });

  // 菜品：招牌湯麵
  const dish = await asChef<{ recipe_id: string; version_id: string }>('create_recipe', {
    p: { type: 'dish', menu_category: '湯麵（示範）', name: '招牌湯麵（示範）', description: '虛構的示範資料' },
  });
  await asChef('save_version_draft', {
    p_version_id: dish.version_id,
    p_revision: 1,
    p: {
      title: '第一版',
      serving_qty: 640,
      serving_unit: 'g',
      lines: [
        { id: uuid(), line_kind: 'component', component_version_id: soup.version_id, quantity: 420, unit: 'g', group_label: '湯' },
        { id: uuid(), line_kind: 'ingredient', ingredient_id: noodle, quantity: 150, unit: 'g', group_label: '麵' },
        { id: uuid(), line_kind: 'ingredient', ingredient_id: scallion, quantity: 10, unit: 'g', group_label: '配料', prep_note: '切蔥花' },
        { id: uuid(), line_kind: 'ingredient', ingredient_id: egg, quantity: 1, unit: '顆', group_label: '配料', prep_note: '溏心蛋' },
      ],
      steps: [
        { id: uuid(), instruction: '湯底加熱至沸騰。', heat_level: 'high' },
        { id: uuid(), instruction: '麵條下滾水煮 90 秒，瀝乾入碗。', duration_minutes: 1.5 },
        { id: uuid(), instruction: '注入湯底，放上配料出餐。', temperature_c: 85, is_critical: true, critical_note: '出餐湯溫 ≥ 85°C' },
      ],
    },
  });
  await api.rpcAs(founder, 'set_menu_price', { p_recipe_id: dish.recipe_id, p_price: 90, p_effective_date: '2026-09-01', p_note: '示範售價' });
  await asChef('transition_version', { p_version_id: dish.version_id, p_to: 'testing', p_comment: '' });

  // 試菜與評分
  const session = await api.rpcAs<string>(manager, 'create_tasting_session', {
    p: {
      tasted_on: '2026-09-15',
      title: '示範：第一輪試菜',
      location: '中央廚房',
      items: [
        { version_id: soup.version_id, blind_label: 'A', maker_id: chef, assigned_tester_ids: [tester1, tester2] },
        { version_id: dish.version_id, maker_id: chef, assigned_tester_ids: [tester1, tester2, manager] },
      ],
    },
  });
  const detail = await api.rpcAs<{ items: Array<{ id: string }> }>(manager, 'get_tasting_session', { p_id: session });
  const [soupItem, dishItem] = detail.items.map((i) => i.id);
  await api.rpcAs(tester1, 'submit_feedback', {
    p_item_id: soupItem,
    p: { score_overall: 4, score_flavor: 4, score_aroma: 4, saltiness: 0, oiliness: -1, issues: '後段略淡', suggestions: '大骨可再多一些', menu_ready: 'maybe' },
  });
  await api.rpcAs(tester2, 'submit_feedback', {
    p_item_id: soupItem,
    p: { score_overall: 5, score_flavor: 5, saltiness: 0, oiliness: 0, suggestions: '湯色漂亮', menu_ready: 'yes' },
  });
  await api.rpcAs(tester1, 'submit_feedback', {
    p_item_id: dishItem,
    p: { score_overall: 3, score_texture: 3, saltiness: 1, issues: '麵條稍軟', suggestions: '麵煮 75 秒試試', menu_ready: 'maybe' },
  });

  // 湯底送核准並定版（定版時帶入前端算出的成本快照）
  await asChef('transition_version', { p_version_id: soup.version_id, p_to: 'pending_approval', p_comment: '兩位試吃平均 4.5 分' });
  const bundle = await api.rpcAs<CostingBundle>(founder, 'get_costing_bundle', { p_version_ids: [soup.version_id] });
  const cost = computeVersionCost(bundle, soup.version_id);
  const metrics = priceMetrics(cost.servingCost, bundle.versions[soup.version_id], bundle.settings);
  await api.rpcAs(founder, 'transition_version', {
    p_version_id: soup.version_id,
    p_to: 'locked',
    p_comment: '湯頭清爽，定版',
    p_snapshot: buildSnapshot(cost, metrics, bundle.as_of),
  });
}
