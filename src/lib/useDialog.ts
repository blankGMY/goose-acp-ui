/**
 * Promise-based in-app dialogs, replacing window.confirm / window.prompt
 * (which clash with the app's look and behave poorly on mobile).
 *
 * Usage: mount one <AppDialog v-bind="dialog" @confirm="onDialogConfirm"
 * @cancel="onDialogCancel" /> in the component, then
 *   if (await askConfirm('', t('...'))) { ... }
 *   const name = await askPrompt(t('...'), currentName);
 */
import { reactive } from 'vue';

export interface DialogState {
  visible: boolean;
  title: string;
  message: string;
  mode: 'confirm' | 'prompt';
  initialValue: string;
  confirmLabel: string;
  danger: boolean;
}

export function useDialog() {
  const dialog = reactive<DialogState>({
    visible: false,
    title: '',
    message: '',
    mode: 'confirm',
    initialValue: '',
    confirmLabel: '',
    danger: false,
  });

  let resolve: ((value: string | null) => void) | null = null;

  function ask(opts: Partial<DialogState>): Promise<string | null> {
    Object.assign(dialog, {
      title: '',
      message: '',
      mode: 'confirm',
      initialValue: '',
      confirmLabel: '',
      danger: false,
      ...opts,
      visible: true,
    });
    return new Promise((r) => {
      resolve = r;
    });
  }

  /** Resolves true when confirmed, false when cancelled. */
  function askConfirm(message: string, opts: Partial<DialogState> = {}): Promise<boolean> {
    return ask({ ...opts, message, mode: 'confirm' }).then((v) => v !== null);
  }

  /** Resolves the entered text, or null when cancelled. */
  function askPrompt(title: string, initialValue = ''): Promise<string | null> {
    return ask({ title, mode: 'prompt', initialValue });
  }

  function onDialogConfirm(value: string) {
    dialog.visible = false;
    resolve?.(value);
    resolve = null;
  }

  function onDialogCancel() {
    dialog.visible = false;
    resolve?.(null);
    resolve = null;
  }

  return { dialog, askConfirm, askPrompt, onDialogConfirm, onDialogCancel };
}
