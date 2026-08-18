// WhatsApp adapter interface + built-in deeplink implementation.
// Swap in a real provider adapter (Meta, 360dialog, etc.) without touching routes.

export interface NormalizedInboundMessage {
  externalId: string;
  fromIdentifier: string;
  toIdentifier: string;
  type: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'AUDIO' | 'VIDEO' | 'TEMPLATE';
  body: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface WhatsAppAdapter {
  buildDeepLink(identifier: string, channelType?: string): string;
  validateDestination(identifier: string, channelType?: string): boolean;
  normalizeInboundMessage(payload: unknown): NormalizedInboundMessage | null;
}

// ── DeeplinkAdapter ───────────────────────────────────────────────────────────
// Builds wa.me / chat.whatsapp.com URLs. No outbound API calls.
// ponytail: swap for MetaCloudAdapter when WA Business API credentials land.

export class DeeplinkAdapter implements WhatsAppAdapter {
  buildDeepLink(identifier: string, channelType = 'INDIVIDUAL_NUMBER'): string {
    if (channelType === 'GROUP') {
      return identifier.startsWith('http')
        ? identifier
        : `https://chat.whatsapp.com/${identifier}`;
    }
    const digits = identifier.replace(/\D/g, '');
    return `https://wa.me/${digits}`;
  }

  validateDestination(identifier: string, channelType = 'INDIVIDUAL_NUMBER'): boolean {
    if (channelType === 'GROUP') return identifier.trim().length > 0;
    if (channelType === 'USERNAME') return identifier.trim().length > 0;
    const digits = identifier.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15;
  }

  normalizeInboundMessage(payload: unknown): NormalizedInboundMessage | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;

    // Accept a simple normalized format:
    // { externalId, from, to, type, body, timestamp }
    if (
      typeof p.externalId !== 'string' ||
      typeof p.from !== 'string' ||
      typeof p.to !== 'string' ||
      typeof p.body !== 'string'
    ) return null;

    const validTypes = ['TEXT', 'IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO', 'TEMPLATE'] as const;
    const type = (typeof p.type === 'string' && validTypes.includes(p.type as any))
      ? (p.type as NormalizedInboundMessage['type'])
      : 'TEXT';

    return {
      externalId: p.externalId,
      fromIdentifier: p.from,
      toIdentifier: p.to,
      type,
      body: p.body,
      timestamp: p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp as string ?? Date.now()),
      metadata: typeof p.metadata === 'object' && p.metadata !== null
        ? (p.metadata as Record<string, unknown>)
        : undefined,
    };
  }
}

export const defaultAdapter: WhatsAppAdapter = new DeeplinkAdapter();
