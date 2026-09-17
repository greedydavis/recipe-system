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
  { from: 'draft', to: 'testing', roles: ['founder', 'chef'], label: '送試菜', commentLabel: null, commentRequired: false, tone: 'primary' },
  { from: 'draft', to: 'pending_approval', roles: ['founder', 'chef'], label: '直接送核准', commentLabel: '免試菜原因', commentRequired: true, tone: 'neutral' },
  { from: 'testing', to: 'pending_approval', roles: ['founder', 'chef'], label: '送核准', commentLabel: '送審說明', commentRequired: true, tone: 'primary' },
  { from: 'testing', to: 'draft', roles: ['founder', 'chef'], label: '退回草案', commentLabel: null, commentRequired: false, tone: 'neutral' },
  { from: 'testing', to: 'retired', roles: ['founder', 'chef'], label: '放棄此版本', commentLabel: '停用原因', commentRequired: true, tone: 'danger' },
  { from: 'pending_approval', to: 'locked', roles: ['founder'], label: '核准定版', commentLabel: '核准意見（可留空）', commentRequired: false, tone: 'primary' },
  { from: 'pending_approval', to: 'testing', roles: ['founder'], label: '退回試菜', commentLabel: '退回原因', commentRequired: true, tone: 'neutral' },
  { from: 'pending_approval', to: 'retired', roles: ['founder', 'chef'], label: '放棄此版本', commentLabel: '停用原因', commentRequired: true, tone: 'danger' },
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

export const isEditable = (status: VersionStatus) => status === 'draft';

/** 可以被其他版本引用的狀態（內容已凍結） */
export const isReferenceable = (status: VersionStatus) =>
  status === 'testing' || status === 'pending_approval' || status === 'locked';

export const canBeTasted = isReferenceable;
