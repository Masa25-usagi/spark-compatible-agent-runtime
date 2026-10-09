import type {
  TaskRecord,
  ApprovalRecord,
  SkillRecord,
  ScheduleRecord,
  AuditEvent,
  AuditVerification,
  RuntimeEvent,
  TaskProgress,
} from './types';

export interface DashboardResponse {
  tasks: TaskRecord[];
  pendingApprovals: ApprovalRecord[];
  audit: AuditVerification;
  stats: {
    taskCount: number;
    runningCount: number;
    pendingApprovalCount: number;
    skillCount: number;
    scheduleCount: number;
  };
}

export interface ApprovalExecutionResponse {
  approval: ApprovalRecord;
  executionResult: {
    outcome: string;
    success: boolean;
    summary: string;
    changedTargets: string[];
  };
}

// Bearer token is injected at startup via the meta tag set by the API server.
// Fallback: read from localStorage so the user can paste it manually.
function getToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="spark-token"]');
  if (meta?.content) return meta.content;
  return localStorage.getItem('spark-token') ?? '';
}

/** Call this once at app start if you have a token string (e.g. from query param). */
export function setToken(token: string): void {
  localStorage.setItem('spark-token', token);
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(`/api/v1${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let message = response.statusText || `HTTP ${response.status}`;
    try {
      const parsed: unknown = JSON.parse(body);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'error' in parsed &&
        typeof parsed.error === 'string' &&
        parsed.error.trim().length > 0
      ) {
        message = parsed.error;
      }
    } catch {
      // Keep the short HTTP status when the response is not a JSON error envelope.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export const api = {
  getDashboard: () => request<DashboardResponse>('/dashboard'),
  getTasks: () => request<TaskRecord[]>('/tasks'),
  getTask: (id: string) =>
    request<{
      task: TaskRecord;
      progress: TaskProgress;
      approvals: ApprovalRecord[];
      events: RuntimeEvent[];
    }>(`/tasks/${id}`),
  createTask: (body: {
    title?: string;
    instruction?: string;
    plannedSteps?: string[];
    agent?: string;
    model?: string;
  }) => request<TaskRecord>('/tasks', { method: 'POST', body: JSON.stringify(body) }),
  suggestSteps: (
    instruction: string,
    selection?: { provider?: 'antigravity' | 'codex'; model?: string },
  ) =>
    request<{
      title: string;
      steps: string[];
      provider: string;
      model: string;
      usedLlm: boolean;
    }>('/tasks/suggest-steps', {
      method: 'POST',
      body: JSON.stringify({ instruction, ...selection }),
    }),
  stopTask: (id: string, reason = 'Stopped via UI') =>
    request<TaskRecord>(`/tasks/${id}/stop`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  resumeTask: (id: string) => request<TaskRecord>(`/tasks/${id}/resume`, { method: 'POST' }),
  dispatchTask: (id: string, mode?: 'plan' | 'workspace') =>
    request<TaskRecord>(`/tasks/${id}/dispatch`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  cancelTaskDispatch: (id: string) =>
    request<{ success: boolean; task: TaskRecord }>(`/tasks/${id}/cancel-dispatch`, {
      method: 'POST',
    }),
  getAgentProviders: () =>
    request<{
      providers: Array<{
        id: string;
        name: string;
        available: boolean;
        models: string[];
        defaultModel: string;
        capabilityText: string;
        quotaAvailability: string;
        customModelSupport: boolean;
      }>;
    }>('/agent-providers'),
  getApprovals: (status?: 'pending') =>
    request<ApprovalRecord[]>(`/approvals${status ? `?status=${status}` : ''}`),
  approveApproval: (id: string, confirm = false) =>
    request<ApprovalExecutionResponse>(`/approvals/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ confirm }),
    }),
  denyApproval: (id: string, reason: string) =>
    request<ApprovalRecord>(`/approvals/${id}/deny`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  getSkills: () => request<SkillRecord[]>('/skills'),
  toggleSkill: (name: string) =>
    request<SkillRecord>(`/skills/${encodeURIComponent(name)}/toggle`, { method: 'PATCH' }),
  createSkill: (body: { name: string; description: string; instructions?: string }) =>
    request<SkillRecord>('/skills', { method: 'POST', body: JSON.stringify(body) }),
  deleteSkill: (name: string) =>
    request<{ deleted: boolean }>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  getSchedules: () => request<ScheduleRecord[]>('/schedules'),
  pauseSchedule: (id: string, reason?: string) =>
    request<ScheduleRecord>(`/schedules/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  resumeSchedule: (id: string) =>
    request<ScheduleRecord>(`/schedules/${id}/resume`, { method: 'POST' }),
  getAudit: () => request<AuditEvent[]>('/audit'),
  verifyAudit: () => request<AuditVerification>('/audit/verify'),
};
