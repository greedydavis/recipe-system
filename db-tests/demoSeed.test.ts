import { expect, it } from 'vitest';
import { seedDemoData } from '../src/data/demoSeed';
import { createTestDb } from './harness';

it('示範資料可以依照資料庫規則建立（含定版與成本快照）', async () => {
  const t = await createTestDb({ withUsers: false });
  await seedDemoData({
    createUser: async (email, name) => {
      const [row] = await t.sql<{ id: string }>(
        'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
        [email, JSON.stringify({ display_name: name })],
      );
      return row.id;
    },
    setRole: async (id, role) => {
      await t.sql('update app.profiles set role = $1 where id = $2', [role, id]);
    },
    rpcAs: (uid, fn, args) => t.rpc(uid, fn, args),
  });
  const [founder] = await t.sql<{ id: string }>(`select id from app.profiles where role = 'founder'`);
  const recipes = await t.rpc<Array<{ name: string; locked: unknown; latest: { status: string } }>>(founder.id, 'list_recipes');
  expect(recipes.map((r) => [r.name, r.latest.status])).toEqual([
    ['招牌湯底（示範）', 'locked'],
    ['招牌湯麵（示範）', 'testing'],
  ]);
  const [snap] = await t.sql<{ cost_per_serving: string; is_complete: boolean }>(
    'select cost_per_serving::text, is_complete from app.cost_snapshots',
  );
  expect(snap.is_complete).toBe(true);
  expect(Number(snap.cost_per_serving).toFixed(4)).toBe('13.1183');
});
