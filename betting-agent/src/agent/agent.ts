// Claude-powered betting analyst: the tool runner drives the loop over our quant tools
// plus server-side web search for news, line-ups and live odds.

import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { SYSTEM_PROMPT } from './prompt.ts';
import { buildTools } from './tools.ts';
import { BetLog } from './store.ts';

export interface AgentOptions {
    log: BetLog;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    onText?: (text: string) => void;
    onTool?: (name: string) => void;
}

export class BettingAgent {
    private client = new Anthropic();
    private history: BetaMessageParam[] = [];
    private tools;
    private opts: AgentOptions;

    constructor(opts: AgentOptions) {
        this.opts = opts;
        this.tools = buildTools({ log: opts.log, bankroll: () => opts.log.bankroll() });
    }

    async ask(question: string): Promise<BetaMessage> {
        const today = new Date().toISOString().slice(0, 10);
        this.history.push({ role: 'user', content: `[Fecha: ${today} · Banca actual: ${this.opts.log.bankroll()}]\n${question}` });

        const runner = this.client.beta.messages.toolRunner({
            model: this.opts.model ?? 'claude-opus-5-5',
            max_tokens: 32000,
            max_iterations: 30,
            thinking: { type: 'adaptive' },
            output_config: { effort: this.opts.effort ?? 'high' },
            // Re-runs the request on a fallback model if the primary declines.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            tools: [...this.tools, { type: 'web_search_20260209', name: 'web_search', max_uses: 10 }],
            messages: this.history
        });

        let last: BetaMessage | undefined;
        for await (const message of runner) {
            last = message;
            for (const block of message.content) {
                if (block.type === 'text') this.opts.onText?.(block.text);
                else if (block.type === 'tool_use' || block.type === 'server_tool_use') this.opts.onTool?.(block.name);
            }
        }
        if (!last) throw new Error('El modelo no devolvió respuesta');

        this.history = [...runner.params.messages];
        if (this.history.at(-1)?.role !== 'assistant') this.history.push({ role: 'assistant', content: last.content });
        if (last.stop_reason === 'refusal') this.opts.onText?.('[El modelo declinó responder a esta petición]');
        return last;
    }
}
