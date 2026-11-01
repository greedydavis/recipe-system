import type { Role, VersionStatus } from './types';

export interface Transition {
  from: VersionStatus;
  to: VersionStatus;
  roles: Role[];
  label: string;
  /** 需要填寫的意見欄位名稱；null 代表不需要 */
  commentLabel: string | null;
  commentRequired: boolean;
  tone: 'primary' | 'neutral' | 'danger';
}

/** 必須和資料庫 app.transition_roles 一致（db-tests 會比對） */
export const TRANSITIONS: Transition[] = [
  { from: 'draft', to: 'locked', roles: ['founder'], label: '定版', commentLabel: '定版說明（可留空）', commentRequired: false, tone: 'primary' },
  { from: 'locked', to: 'retired', roles: ['founder'], label: '停用', commentLabel: '停用原因', commentRequired: true, tone: 'danger' },
];

export const STATUSES: VersionStatus[] = ['draft', 'testing', 'pending_approval', 'locked', 'retired'];

export function transitionRoles(from: VersionStatus, to: VersionStatus): Role[] | null {
  return TRANSITIONS.find((t) => t.from === from && t.to === to)?.roles ?? null;
}

export function availableTransitions(from: VersionStatus, role: Role | null | undefined): Transition[] {
  if (!role) return [];
  return TRANSITIONS.filter((t) => t.from === from && t.roles.includes(role));
}

/** 可以被引用的版本：草案也可以，菜品定版時才要求引用的元件已定版 */
export const isReferenceable = (status: VersionStatus) => status !== 'retired';
