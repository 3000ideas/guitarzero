/**
 * «Ajustar automáticamente»: button + result box shared by the grid's sync panel and the
 * Comprobar view. The editor runs `fitSync` (dsp/syncFit.ts) and shows the outcome here; nothing
 * changes until the user presses «Aplicar».
 */
import { h } from './dom';
import { describeFit, type SyncFit } from '../dsp/syncFit';

export interface AutoSyncOpts {
  onRun: () => void;
  onApply: () => void;
  onDiscard: () => void;
}

export interface AutoSyncBox {
  el: HTMLElement;
  /** Enabled only with an audio track loaded. */
  setAvailable(available: boolean): void;
  setBusy(busy: boolean): void;
  /** Shows a fit (null clears the box). */
  show(fit: SyncFit | null): void;
}

export function createAutoSyncBox(opts: AutoSyncOpts): AutoSyncBox {
  const runBtn = h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => opts.onRun() }, '✨ Ajustar automáticamente') as HTMLButtonElement;
  const hint = h('span.muted.small', null, 'Compara los golpes del texto con el audio y calcula el inicio (y el tempo si hace falta).');
  const text = h('div.auto-sync-text');
  const apply = h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => opts.onApply() }, 'Aplicar') as HTMLButtonElement;
  const discard = h('button.btn.btn-sm', { type: 'button', onclick: () => opts.onDiscard() }, 'Descartar') as HTMLButtonElement;
  const result = h('div.auto-sync-result', { role: 'status' }, text, h('div.auto-sync-actions', null, apply, discard));
  result.hidden = true;
  const el = h('div.auto-sync', null, h('div.auto-sync-row', null, runBtn, hint), result);
  return {
    el,
    setAvailable(available) {
      runBtn.disabled = !available;
      hint.textContent = available ? 'Compara los golpes del texto con el audio y calcula el inicio (y el tempo si hace falta).' : 'Carga un audio en «Pista de audio» para poder ajustar.';
    },
    setBusy(busy) {
      runBtn.disabled = busy;
      runBtn.textContent = busy ? 'Analizando…' : '✨ Ajustar automáticamente';
    },
    show(fit) {
      if (!fit) {
        result.hidden = true;
        return;
      }
      result.hidden = false;
      result.classList.toggle('is-bad', !fit.ok);
      text.textContent = describeFit(fit);
      const changes = fit.ok && (Math.abs(fit.deltaSec) >= 0.003 || fit.tempoFactor !== 1);
      apply.hidden = !changes;
      discard.textContent = changes ? 'Descartar' : 'Cerrar';
    },
  };
}
