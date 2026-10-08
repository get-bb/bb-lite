export interface Viewer {
  id: string;
  login: string;
  name: string;
  avatarUrl: string | null;
  admin: boolean;
  canHost: boolean;
}

export type ServerState =
  | "linked"
  | "signed-out"
  | "creating"
  | "running"
  | "stopped"
  | "failed";

export interface ServerView {
  id: string;
  label: string;
  url: string;
  hosted: boolean;
  clientName: string | null;
  state: ServerState;
  version: string | null;
  update: string | null;
  error: string | null;
  deletesAt: number | null;
}

export interface PersonView {
  id: string;
  login: string;
  name: string;
  avatarUrl: string | null;
  canHost: boolean;
  self: boolean;
}

export interface Dashboard {
  viewer: Viewer;
  baseHost: string;
  servers: ServerView[];
  people: PersonView[];
  hosting: { canCreate: boolean; suggestedLabel: string; idleHours: number };
}

export interface LinkView {
  userCode: string;
  clientName: string;
  suggestedLabel: string;
  baseHost: string;
}

export interface Failure {
  error: string;
  message: string;
}
