import type { TestDb } from './harness';

export async function expectError(promise: Promise<unknown>, message: string | RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const text = (error as Error).message;
    if (typeof message === 'string' ? text.includes(message) : message.test(text)) return;
    throw new Error(`錯誤訊息不符：預期包含「${message}」，實際為「${text}」`);
  }
  throw new Error(`預期發生錯誤「${message}」，但成功執行`);
}

export async function createIngredient(
  t: TestDb,
  opts: {
    name: string;
    base?: 'mass' | 'volume' | 'count';
    waste?: number;
    density?: number;
    packQty?: number;
    packUnit?: string;
    price?: number | null;
    effectiveDate?: string;
  },
): Promise<{ id: string; specId: string | null }> {
  const id = await t.rpc<string>(t.users.chef, 'upsert_ingredient', {
    p: {
      name: opts.name,
      base_dimension: opts.base ?? 'mass',
      default_waste_rate: opts.waste ?? 0,
      density_g_per_ml: opts.density ?? '',
      category: 'other',
    },
  });
  if (opts.packQty === undefined) return { id, specId: null };
  const specId = await t.rpc<string>(t.users.chef, 'upsert_packaging_spec', {
    p: { ingredient_id: id, spec_name: `${opts.packQty} ${opts.packUnit}`, pack_qty: opts.packQty, pack_unit: opts.packUnit },
  });
  if (opts.price !== null && opts.price !== undefined) {
    await t.rpc(t.users.chef, 'add_purchase_price', {
      p_spec_id: specId,
      p_price: opts.price,
      p_effective_date: opts.effectiveDate ?? '2026-01-01',
      p_note: '',
    });
  }
  return { id, specId };
}

export async function createRecipe(
  t: TestDb,
  opts: { type: 'dish' | 'component'; name: string; kind?: string },
): Promise<{ recipeId: string; versionId: string }> {
  const r = await t.rpc<{ recipe_id: string; version_id: string }>(t.users.chef, 'create_recipe', {
    p: { type: opts.type, name: opts.name, component_kind: opts.kind ?? (opts.type === 'component' ? 'soup' : '') },
  });
  return { recipeId: r.recipe_id, versionId: r.version_id };
}

export interface LineInput {
  id?: string;
  line_kind: 'ingredient' | 'component';
  ingredient_id?: string;
  component_version_id?: string;
  quantity: number | null;
  unit: string;
  waste_rate_override?: number | null;
}

export async function saveDraft(
  t: TestDb,
  versionId: string,
  payload: {
    batch?: [number, string];
    serving: [number, string];
    lines: LineInput[];
    steps?: Array<{ instruction: string; duration_minutes?: number }>;
  },
  user?: string,
): Promise<number> {
  const current = await t.rpc<{ revision: number }>(user ?? t.users.chef, 'get_version', { p_id: versionId });
  return t.rpc<number>(user ?? t.users.chef, 'save_version_draft', {
    p_version_id: versionId,
    p_revision: current.revision,
    p: {
      batch_output_qty: payload.batch?.[0] ?? payload.serving[0],
      batch_output_unit: payload.batch?.[1] ?? payload.serving[1],
      serving_qty: payload.serving[0],
      serving_unit: payload.serving[1],
      lines: payload.lines.map((l) => ({ ...l, id: l.id ?? crypto.randomUUID() })),
      steps: (payload.steps ?? []).map((s) => ({ ...s, id: crypto.randomUUID() })),
    },
  });
}

export function transition(t: TestDb, user: string, versionId: string, to: string, comment = '', snapshot: unknown = null) {
  return t.rpc(user, 'transition_version', {
    p_version_id: versionId,
    p_to: to,
    p_comment: comment,
    p_snapshot: snapshot,
  });
}

export const COMPLETE_SNAPSHOT = { is_complete: true, batch_cost: '10', cost_per_serving: '1', detail: {} };
