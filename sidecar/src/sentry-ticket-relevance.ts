import type { Ticket } from './stores/tickets';
import type { SentryRelevance } from './stores/sentry';

export function classifySentryIssue(issue: { title?: string; transaction?: string | null; culprit?: string | null }, tickets: Ticket[]): SentryRelevance {
  const text = [issue.title, issue.transaction, issue.culprit].filter(Boolean).join(' ').toLowerCase();
  const reasons = tickets.flatMap((ticket) => {
    const terms = [...new Set(ticket.title.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4))];
    const matches = terms.filter((term) => text.includes(term));
    const explicit = text.includes(ticket.key.toLowerCase());
    return explicit || matches.length >= 2 ? [{ ticket: ticket.key, signal: explicit ? ticket.key : matches.slice(0, 2).join(' + ') }] : [];
  });
  return { matched: reasons.length > 0, reasons };
}
