// Wizard engine: step-by-step conversational flows for Telegram

import { Bot, InlineKeyboard } from "grammy";

export interface WizardStep {
  id: string;
  prompt: string | ((data: Record<string, string>) => string);
  validate?: (input: string, data: Record<string, string>) => string | null;
  transform?: (input: string) => string;
  options?: { label: string; value: string }[] | ((data: Record<string, string>) => { label: string; value: string }[]);
  /** Number of buttons per row (default: all in one row) */
  columns?: number;
  skip?: (data: Record<string, string>) => boolean;
}

export interface WizardDef {
  id: string;
  steps: WizardStep[];
  onComplete: (data: Record<string, string>, chatId: number, bot: Bot) => Promise<string>;
}

interface ActiveWizard {
  def: WizardDef;
  stepIndex: number;
  data: Record<string, string>;
  chatId: number;
  timer: NodeJS.Timeout;
}

const WIZARD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const activeWizards = new Map<number, ActiveWizard>();

export function cancelWizard(chatId: number): boolean {
  const w = activeWizards.get(chatId);
  if (!w) return false;
  clearTimeout(w.timer);
  activeWizards.delete(chatId);
  return true;
}

export async function startWizard(chatId: number, def: WizardDef, bot: Bot): Promise<void> {
  cancelWizard(chatId);

  const timer = setTimeout(() => {
    activeWizards.delete(chatId);
    bot.api.sendMessage(chatId, "Wizard timed out. Run the command again.").catch(() => {});
  }, WIZARD_TIMEOUT_MS);

  const wizard: ActiveWizard = { def, stepIndex: 0, data: {}, chatId, timer };
  activeWizards.set(chatId, wizard);
  await sendCurrentStep(wizard, bot);
}

async function sendCurrentStep(wizard: ActiveWizard, bot: Bot): Promise<void> {
  while (wizard.stepIndex < wizard.def.steps.length) {
    const step = wizard.def.steps[wizard.stepIndex];
    if (step.skip?.(wizard.data)) {
      wizard.stepIndex++;
      continue;
    }
    break;
  }

  if (wizard.stepIndex >= wizard.def.steps.length) {
    await completeWizard(wizard, bot);
    return;
  }

  const step = wizard.def.steps[wizard.stepIndex];
  const prompt = typeof step.prompt === "function" ? step.prompt(wizard.data) : step.prompt;
  const options = typeof step.options === "function" ? step.options(wizard.data) : step.options;

  if (options && options.length > 0) {
    const kb = new InlineKeyboard();
    const cols = step.columns ?? options.length; // default: all in one row
    for (let i = 0; i < options.length; i++) {
      kb.text(options[i].label, `wizard:${step.id}:${options[i].value}`);
      if ((i + 1) % cols === 0 && i + 1 < options.length) kb.row();
    }
    await bot.api.sendMessage(wizard.chatId, prompt, { reply_markup: kb });
  } else {
    await bot.api.sendMessage(wizard.chatId, prompt);
  }
}

export async function advanceWizard(chatId: number, input: string, bot: Bot): Promise<boolean> {
  const wizard = activeWizards.get(chatId);
  if (!wizard) return false;

  const step = wizard.def.steps[wizard.stepIndex];
  const value = step.transform ? step.transform(input) : input.trim();

  if (step.validate) {
    const error = step.validate(value, wizard.data);
    if (error) {
      await bot.api.sendMessage(chatId, `${error}\n\nTry again or /cancel:`);
      return true;
    }
  }

  wizard.data[step.id] = value;
  wizard.stepIndex++;

  clearTimeout(wizard.timer);
  wizard.timer = setTimeout(() => {
    activeWizards.delete(chatId);
    bot.api.sendMessage(chatId, "Wizard timed out. Run the command again.").catch(() => {});
  }, WIZARD_TIMEOUT_MS);

  await sendCurrentStep(wizard, bot);
  return true;
}

async function completeWizard(wizard: ActiveWizard, bot: Bot): Promise<void> {
  cancelWizard(wizard.chatId);
  try {
    const message = await wizard.def.onComplete(wizard.data, wizard.chatId, bot);
    await bot.api.sendMessage(wizard.chatId, message);
  } catch (err) {
    await bot.api.sendMessage(wizard.chatId, `Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function hasActiveWizard(chatId: number): boolean {
  return activeWizards.has(chatId);
}
