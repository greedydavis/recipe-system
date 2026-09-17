import type { ComponentKind, Dimension, RecipeType, Role, VersionStatus } from '../domain/types';

export const ROLE_LABEL: Record<Role, string> = {
  founder: '創辦人',
  chef: '研發／主廚',
  manager: '店長',
  tester: '測試人員',
  pending: '待審核',
};

export const STATUS_LABEL: Record<VersionStatus, string> = {
  draft: '草案',
  testing: '試菜中',
  pending_approval: '待核准',
  locked: '已定版',
  retired: '停用',
};

export const STATUS_STYLE: Record<VersionStatus, string> = {
  draft: 'bg-stone-100 text-stone-700 ring-stone-300',
  testing: 'bg-amber-50 text-amber-800 ring-amber-300',
  pending_approval: 'bg-sky-50 text-sky-800 ring-sky-300',
  locked: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  retired: 'bg-zinc-100 text-zinc-500 ring-zinc-300',
};

export const RECIPE_TYPE_LABEL: Record<RecipeType, string> = {
  dish: '菜品',
  component: '元件',
};

export const COMPONENT_KIND_LABEL: Record<ComponentKind, string> = {
  soup: '湯底',
  sauce: '醬料',
  topping: '配料',
  noodle: '麵條',
  other: '其他',
};

export const DIMENSION_LABEL: Record<Dimension, string> = {
  mass: '重量（公克）',
  volume: '容量（毫升）',
  count: '個數（個）',
};

export const INGREDIENT_CATEGORY_LABEL: Record<string, string> = {
  meat: '肉品',
  seafood: '海鮮',
  produce: '蔬果',
  dry_goods: '乾貨',
  seasoning: '調味料',
  oil: '油脂',
  grain: '麵粉／米／澱粉',
  egg_soy_dairy: '蛋／豆／乳製品',
  beverage: '飲品原料',
  packaging: '包材',
  other: '其他',
};

export const HEAT_LABEL: Record<string, string> = {
  high: '大火',
  medium: '中火',
  low: '小火',
  simmer: '微火',
};

export const MENU_READY_LABEL: Record<string, string> = {
  yes: '可以上菜單',
  maybe: '再調整',
  no: '不建議',
};

export const SALTINESS_LABELS = ['太淡', '偏淡', '剛好', '偏鹹', '太鹹'];
export const OILINESS_LABELS = ['太清', '清爽', '剛好', '偏油', '太油'];

export const TABLE_LABEL: Record<string, string> = {
  profiles: '帳號',
  app_settings: '系統設定',
  units: '單位',
  ingredients: '原物料',
  ingredient_units: '原物料單位',
  suppliers: '供應商',
  packaging_specs: '包裝規格',
  purchase_prices: '單價',
  recipes: '菜品／元件',
  menu_prices: '售價',
  recipe_versions: '食譜版本',
  recipe_lines: '用料',
  recipe_steps: '步驟',
  version_status_history: '狀態歷程',
  cost_snapshots: '成本快照',
  tasting_sessions: '試菜場次',
  tasting_items: '試做項目',
  tasting_feedback: '試吃評分',
  photos: '照片',
};

export const ACTION_LABEL: Record<string, string> = {
  insert: '新增',
  update: '修改',
  delete: '刪除',
};
