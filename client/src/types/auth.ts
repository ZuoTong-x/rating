export type UserRole = 'admin' | 'scorer';
export type AvailabilityStatus = 'enabled' | 'disabled';

export interface AccountTeam {
  id: string;
  name: string;
  status: AvailabilityStatus;
  userCount?: number;
  projectCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  status: AvailabilityStatus;
  mustChangePassword?: boolean;
  disabledByTeam?: boolean;
  teams?: AccountTeam[];
  lastLoginAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface AuthUserPage {
  total: number;
  page: number;
  pageSize: number;
  users: AuthUser[];
}

export interface ScorerUserBatchSkippedItem {
  username: string;
  reason: string;
}

export interface ScorerUserBatchCreateResult {
  users: AuthUser[];
  createdCount: number;
  skipped: ScorerUserBatchSkippedItem[];
  skippedCount: number;
}
