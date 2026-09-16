#!/usr/bin/env node
/**
 * battle-lineup — pick the skirmish matchup, get the plan.
 *
 *   battle-lineup                                    interactive
 *   battle-lineup --enemy gla_stealth                engine picks your side
 *   battle-lineup --you china --enemy usa_air -d hard
 *   battle-lineup --you gla --enemy china_tank --map alpine_assault --json
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Difficulty } from '../types.js';
import { loadDataset } from '../data/index.js';
import { generatePlan } from '../index.js';
import { renderPlan, renderFactionList, renderMapList, bold, dim, green, blue } from './render.js';

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard', 'brutal'];

const HELP = `
${bold('battle-lineup')} - Command & Conquer: Generals - Zero Hour skirmish planner

  Pick your side, the enemy side, or neither. Pick a difficulty. Get a plan.

${bold('USAGE')}
  battle-lineup [options]

${bold('OPTIONS')}
  -y, --you <faction>        Your army. Omit it and the engine picks the best answer.
  -e, --enemy <faction>      Enemy army. Omit it and one is chosen at random.
  -d, --difficulty <level>   easy | medium | hard | brutal   (default: medium)
  -m, --map <map>            Map id, for terrain-specific advice.
      --seed <n>             Deterministic randomness, for reproducible picks.
      --json                 Emit the plan as JSON instead of prose.
      --list-factions        Show every playable army and exit.
      --list-maps            Show every map and exit.
  -h, --help                 This message.

${bold('EXAMPLES')}
  battle-lineup --enemy gla_stealth --difficulty hard
  battle-lineup --you usa_laser --enemy china_tank --map winding_river
  battle-lineup --list-factions
`;

function parseCli() {
  return parseArgs({
    options: {
      you: { type: 'string', short: 'y' },
      enemy: { type: 'string', short: 'e' },
      difficulty: { type: 'string', short: 'd', default: 'medium' },
      map: { type: 'string', short: 'm' },
      seed: { type: 'string' },
      json: { type: 'boolean', default: false },
      'list-factions': { type: 'boolean', default: false },
      'list-maps': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  }).values;
}

function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as string[]).includes(value);
}

/** Interactive prompts, used when the command is run with no arguments. */
async function interactive(): Promise<{ you?: string; enemy?: string; difficulty: Difficulty; mapId?: string }> {
  const ds = loadDataset();
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    stdout.write('\n' + bold(green('  BATTLE LINEUP')) + dim('  ·  Generals: Zero Hour\n'));
    stdout.write(dim('  Press enter to leave any choice to the planner.\n'));
    stdout.write(renderFactionList(ds));

    const ask = async (question: string, valid: (v: string) => boolean): Promise<string | undefined> => {
      for (;;) {
        const answer = (await rl.question(question)).trim().toLowerCase();
        if (!answer) return undefined;
        if (valid(answer)) return answer;
        stdout.write(dim('    not recognised - try again, or press enter to skip\n'));
      }
    };

    const isFaction = (v: string) => ds.factions.some((f) => f.id === v);
    const you = await ask(`  ${blue('Your army')} ${dim('(id, or enter to let the planner choose)')}: `, isFaction);
    const enemy = await ask(`  ${blue('Enemy army')} ${dim('(id, or enter for a surprise)')}: `, isFaction);

    const diff = await ask(`  ${blue('Difficulty')} ${dim('[easy|medium|hard|brutal]')}: `, isDifficulty);

    stdout.write(renderMapList(ds));
    const mapId = await ask(`  ${blue('Map')} ${dim('(id, or enter to skip)')}: `, (v) =>
      ds.maps.some((m) => m.id === v),
    );

    return {
      ...(you ? { you } : {}),
      ...(enemy ? { enemy } : {}),
      difficulty: (diff as Difficulty | undefined) ?? 'medium',
      ...(mapId ? { mapId } : {}),
    };
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const args = parseCli();

  if (args.help) {
    stdout.write(HELP);
    return 0;
  }

  const ds = loadDataset();

  if (args['list-factions']) {
    stdout.write(renderFactionList(ds));
    return 0;
  }
  if (args['list-maps']) {
    stdout.write(renderMapList(ds));
    return 0;
  }

  const noSelection = !args.you && !args.enemy && !args.map && args.difficulty === 'medium';
  const input = noSelection && stdin.isTTY
    ? await interactive()
    : {
        ...(args.you ? { you: args.you } : {}),
        ...(args.enemy ? { enemy: args.enemy } : {}),
        difficulty: args.difficulty!,
        ...(args.map ? { mapId: args.map } : {}),
      };

  if (!isDifficulty(input.difficulty)) {
    process.stderr.write(`Unknown difficulty "${input.difficulty}". Use one of: ${DIFFICULTIES.join(', ')}\n`);
    return 1;
  }

  const plan = generatePlan({
    ...input,
    difficulty: input.difficulty,
    ...(args.seed ? { seed: Number(args.seed) } : {}),
  });

  stdout.write(args.json ? JSON.stringify(plan, null, 2) + '\n' : renderPlan(plan, ds));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n  ${message}\n\n  Try: battle-lineup --list-factions\n\n`);
    process.exit(1);
  });
