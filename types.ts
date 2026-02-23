
export enum LeadScore {
  LOW = 'Low',
  MEDIUM = 'Medium',
  HIGH = 'High'
}

export interface LeadStatus {
  intent: string;
  score: LeadScore;
  escalate: boolean;
  lastUpdate: string;
}

export interface Message {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface CallSession {
  id: string;
  status: 'idle' | 'active' | 'connected' | 'ended';
  leadStatus: LeadStatus;
  history: Message[];
}

export interface CallRecord extends CallSession {
  duration: string;
  timestamp: string;
}

export type ViewType = 'live' | 'history' | 'analytics' | 'escalations' | 'settings';
