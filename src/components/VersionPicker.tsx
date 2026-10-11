import { useState } from 'react';
import { Link } from 'react-router';
import { useRpc } from '../data/api';
import type { RecipeDetail, RecipeListItem } from '../data/types';
import { isReferenceable } from '../domain/status';
import type { RecipeType } from '../domain/types';
import { COMPONENT_KIND_LABEL, RECIPE_TYPE_LABEL } from '../i18n/labels';
import { Button, Loading, SearchInput, Sheet, StatusBadge } from './ui';

/**
 * 先選食譜、再選版本。只有內容已凍結的版本（試菜中、待核准、已定版）可以選；
 * 引用元件與加入試菜場次都用這一個。
 */
export function VersionPicker({
  title,
  hint,
  type = null,
  excludeRecipeId,
  excludeVersionIds = [],
  showRecipeLink,
  onPick,
  onClose,
}: {
  title: string;
  hint: string;
  /** 只列出菜品或元件；null 是兩種都列 */
  type?: RecipeType | null;
  excludeRecipeId?: string;
  excludeVersionIds?: string[];
  showRecipeLink?: boolean;
  onPick: (recipe: RecipeDetail, version: RecipeDetail['versions'][number]) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useRpc<RecipeListItem[]>('list_recipes', { p_type: type, p_q: null, p_include_archived: false });
  const detail = useRpc<RecipeDetail>('get_recipe', { p_id: selected }, { enabled: !!selected });
  const term = q.trim();
  const matches = (list.data ?? []).filter((r) => r.id !== excludeRecipeId && (!term || r.name.includes(term)));

  return (
    <Sheet open title={selected ? '選擇版本' : title} onClose={onClose}>
      {!selected ? (
        <>
          <SearchInput value={q} onChange={setQ} placeholder="搜尋名稱" />
          {list.isLoading && <Loading />}
          <div className="divide-y divide-line">
            {matches.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelected(r.id)}
                className="flex min-h-12 w-full items-center gap-2 py-2 text-left hover:bg-brand-50"
              >
                <span className="flex-1">{r.name}</span>
                <span className="text-xs text-muted">
                  {r.type === 'component' ? COMPONENT_KIND_LABEL[r.component_kind ?? 'other'] : RECIPE_TYPE_LABEL[r.type]}
                </span>
                <StatusBadge status={r.locked ? 'locked' : r.latest.status} />
              </button>
            ))}
            {list.data && matches.length === 0 && <p className="py-3 text-sm text-muted">沒有符合的項目；請先到「食譜」建立。</p>}
          </div>
        </>
      ) : (
        <>
          <Button small variant="ghost" onClick={() => setSelected(null)}>
            ← 回到清單
          </Button>
          {detail.isLoading && <Loading />}
          {detail.data && (
            <div className="space-y-2">
              <p className="text-sm text-muted">{hint}</p>
              {detail.data.versions.map((ver) => (
                <button
                  key={ver.id}
                  type="button"
                  disabled={!isReferenceable(ver.status) || excludeVersionIds.includes(ver.id)}
                  onClick={() => onPick(detail.data!, ver)}
                  className="flex min-h-12 w-full items-center gap-2 rounded-xl px-3 py-2 text-left ring-1 ring-line hover:bg-brand-50 disabled:opacity-50"
                >
                  <span className="font-semibold">v{ver.version_no}</span>
                  <span className="flex-1 truncate text-sm">{ver.title}</span>
                  <StatusBadge status={ver.status} />
                </button>
              ))}
              {showRecipeLink && (
                <Link to={`/recipes/${detail.data.id}`} className="inline-block min-h-11 py-2 text-sm text-brand-700">
                  查看詳情 →
                </Link>
              )}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
