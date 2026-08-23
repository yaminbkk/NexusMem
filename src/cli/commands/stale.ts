import pc from 'picocolors';
import { checkContradictions, type ContradictionSuggestion } from '../../retrieval/contradiction.js';
import { DEFAULT_SLM_MODEL, OllamaChatProvider } from '../../slm/provider.js';
import { MemoryStore } from '../../store/store.js';
import { OllamaEmbeddingProvider } from '../../vector/embed.js';
import { loadContext } from '../context.js';

export interface StaleOptions {
  cwd: string;
  minAgeDays?: number;
  limit?: number;
  /**
   * Ask the local SLM whether a similar newer node actually contradicts each
   * candidate, instead of only surfacing by age. Off by default: it costs one
   * embedding call and, for most candidates, one chat completion, so a plain
   * `stale` run stays instant and network-free.
   */
  checkContradictions?: boolean;
  model?: string;
  /**
   * Reject the open contradiction suggestion for this candidate id instead of
   * listing anything -- the missing "no" verb a suggestion needed so a wrong
   * one stops re-printing on every future `stale`/sync without a human
   * pretending `mark-stale` was warranted.
   */
  dismiss?: string;
  out?: (chunk: string) => void;
}

/** Re-exported so `cli/index.ts` doesn't reach into `slm/provider.js` directly -- same convention as `scan-session.ts`'s `SCAN_SESSION_DEFAULT_MODEL`. */
export const STALE_DEFAULT_MODEL = DEFAULT_SLM_MODEL;

/**
 * `nexusmem stale`. Lists non-observed nodes old enough that nothing has
 * confirmed they still hold -- a heuristic surfacing list by default, not
 * contradiction detection. With `--check-contradictions`, candidates that
 * have a similar newer node the SLM judges as actually contradicting them
 * are flagged with a one-line reason -- still only a suggestion, nothing is
 * written. Either way, run `mark-stale` yourself on whichever ids actually
 * turned out wrong.
 */
export async function runStale(opts: StaleOptions): Promise<number> {
  const { projectId, ws } = await loadContext(opts.cwd);
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));

  const store = MemoryStore.open(ws.dbPath);
  try {
    if (opts.dismiss) {
      const dismissed = store.dismissContradictionSuggestion(projectId, opts.dismiss);
      out(
        dismissed > 0
          ? `${pc.green('dismissed')} the contradiction suggestion for ${opts.dismiss} -- it will not resurface\n`
          : `${pc.dim('no open contradiction suggestion')} for ${opts.dismiss} -- nothing to dismiss\n`,
      );
      return 0;
    }

    const candidates = store.listStaleCandidates(projectId, { minAgeDays: opts.minAgeDays, limit: opts.limit });

    if (candidates.length === 0) {
      out(`${pc.dim('no stale candidates')} -- no unconfirmed node older than the threshold lacks a successor\n`);
      return 0;
    }

    let suggestions: ContradictionSuggestion[] = [];
    if (opts.checkContradictions) {
      suggestions = await checkContradictions(
        store,
        new OllamaEmbeddingProvider(),
        new OllamaChatProvider({ model: opts.model ?? DEFAULT_SLM_MODEL }),
        projectId,
        candidates,
        { model: opts.model ?? DEFAULT_SLM_MODEL },
      );
    }

    // Standing YES verdicts (recorded by an earlier run or by sync's
    // automatic leg) decorate the plain listing too -- reading them costs
    // nothing, so `stale` without the flag stays instant and network-free
    // while still showing everything already judged.
    const byCandidateId = new Map<string, Pick<ContradictionSuggestion, 'againstId' | 'againstTitle' | 'reason'>>();
    for (const s of store.listContradictionSuggestions(projectId)) {
      byCandidateId.set(s.candidateId, { againstId: s.againstId, againstTitle: s.againstTitle, reason: s.reason ?? '' });
    }
    for (const s of suggestions) byCandidateId.set(s.candidateId, s);

    out(
      [
        `${pc.bold(String(candidates.length))} stale candidate(s) -- oldest first, none of these were changed:`,
        ...candidates.map((c) => {
          const line = `  ${pc.dim(c.id)} ${pc.yellow(`${c.ageDays}d old`)} [${c.kind}] ${c.title}`;
          const hit = byCandidateId.get(c.id);
          return hit
            ? `${line}\n    ${pc.red('likely superseded by')} ${pc.dim(hit.againstId)} ${hit.againstTitle} -- ${hit.reason}`
            : line;
        }),
        '',
        `run ${pc.bold('nexusmem mark-stale <id> --supersedes <newId>')} on any that are actually wrong`,
      ]
        .join('\n')
        .concat('\n'),
    );
    return 0;
  } finally {
    store.close();
  }
}
