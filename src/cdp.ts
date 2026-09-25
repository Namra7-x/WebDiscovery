// Shared Deep Capture (CDP) contract: imported by background AND panel for types.
// Zero deps, metadata only — no response bodies are ever represented here.

export type CdpWorkerKind = 'page' | 'iframe' | 'worker' | 'serviceworker' | 'unknown';

export interface CdpTargetInfo {
  targetId: string;
  kind: CdpWorkerKind;
  url: string;
  parentId?: string;
}

export interface CdpNetEvent {
  ev: 'req' | 'res' | 'fail' | 'redirect' | 'ws-frame';
  reqId: string;
  url: string;
  method?: string;
  status?: number;
  mime?: string;
  frameId?: string;
  targetId?: string;
  loaderId?: string;
  initiatorUrl?: string;
  protocol?: string;
  timingMs?: number;
  fromServiceWorker?: boolean;
  fromCache?: boolean;
  redirectUrl?: string;
  wsDir?: 'sent' | 'received';
  wsOpcode?: string;
  wsPayload?: string;
}

export function cdpTargetKind(type: string): CdpWorkerKind {
  switch (type) {
    case 'page':
      return 'page';
    case 'iframe':
      return 'iframe';
    case 'worker':
    case 'shared_worker':
      return 'worker';
    case 'service_worker':
      return 'serviceworker';
    default:
      return 'unknown';
  }
}
