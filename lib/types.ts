export const ATS = ["greenhouse", "lever", "workday"] as const;
export type Ats = (typeof ATS)[number];

export const ROLE_FAMILIES = ["swe", "ml", "data", "research", "product", "design", "other"] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];

export const SENIORITIES = ["intern", "new_grad", "other"] as const;
export type Seniority = (typeof SENIORITIES)[number];

export const APPLICATION_STATUSES = [
  "saved",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export type SourceUrl = {
  ats: Ats;
  url: string;
  targetId: string;
};

export type Target = {
  id: string;
  company: string;
  ats: Ats;
  boardToken: string | null;
  workdayHost: string | null;
  workdayTenant: string | null;
  workdaySite: string | null;
  enabled: boolean;
  intervalMinutes: number;
  lastPolledAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastOkAt: string | null;
  createdAt: string;
};

export type TargetInput = {
  company: string;
  ats: Ats;
  boardToken?: string | null;
  workdayHost?: string | null;
  workdayTenant?: string | null;
  workdaySite?: string | null;
  enabled?: boolean;
  intervalMinutes?: number;
};

export type JobDraft = {
  company: string;
  title: string;
  location: string | null;
  url: string;
  ats: Ats;
  targetId: string;
  externalId: string;
  postedAt: string | null;
  // Stored as already alerted: existing jobs on a board's first successful poll.
  quiet?: boolean;
};

export type Job = {
  id: string;
  canonicalUrl: string;
  title: string;
  company: string;
  location: string | null;
  ats: Ats;
  targetId: string | null;
  externalId: string | null;
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  sourceUrls: SourceUrl[];
  titleKey: string;
  isIntern: boolean | null;
  roleFamily: string | null;
  seniority: string | null;
  score: number | null;
  classifyReason: string | null;
  classifyModel: string | null;
  alertedAt: string | null;
};

export type JobFilter = {
  q?: string;
  earlyOnly?: boolean;
  family?: string;
  limit?: number;
};

export type Classification = {
  cacheKey: string;
  title: string;
  isIntern: boolean;
  roleFamily: RoleFamily;
  seniority: Seniority;
  score: number;
  reason: string;
  model: string;
};

export type Application = {
  jobId: string;
  status: ApplicationStatus;
  notes: string;
  updatedAt: string;
  title: string;
  company: string;
  canonicalUrl: string;
};

export type ApplicationInput = {
  jobId: string;
  status?: ApplicationStatus;
  notes?: string;
};

export type PollRun = {
  targetId: string;
  startedAt: string;
  finishedAt: string;
  jobsSeen: number;
  jobsNew: number;
  error: string | null;
};

export type Stats = {
  targets: number;
  targetsEnabled: number;
  jobs: number;
  earlyCareer: number;
  applications: number;
  recentRuns: PollRun[];
};

export interface Store {
  listTargets(): Promise<Target[]>;
  getTarget(id: string): Promise<Target | null>;
  upsertTarget(input: TargetInput): Promise<Target>;
  setTargetEnabled(id: string, enabled: boolean): Promise<void>;
  deleteTarget(id: string): Promise<void>;
  touchTarget(id: string, status: string, error: string | null): Promise<void>;
  upsertJobs(jobs: JobDraft[]): Promise<{ insertedIds: string[] }>;
  listJobs(filter: JobFilter): Promise<Job[]>;
  titlesForIds(ids: string[]): Promise<string[]>;
  titlesNeedingClassification(limit: number): Promise<string[]>;
  getClassifications(cacheKeys: string[]): Promise<Map<string, Classification>>;
  putClassification(row: Classification): Promise<void>;
  applyClassifications(cacheKeys?: string[]): Promise<void>;
  listUnalertedMatches(opts: { sinceHours: number; limit: number; minScore: number }): Promise<Job[]>;
  markAlerted(ids: string[]): Promise<void>;
  listApplications(): Promise<Application[]>;
  upsertApplication(input: ApplicationInput): Promise<Application>;
  deleteApplication(jobId: string): Promise<void>;
  recordRun(run: PollRun): Promise<void>;
  pruneRuns(olderThanDays: number): Promise<void>;
  stats(): Promise<Stats>;
}
