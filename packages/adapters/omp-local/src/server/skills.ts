import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveOmpSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".omp", "agent", "skills");
}

// OMP skills are staged per run into a temp dir that is passed to the CLI via a
// `--config` overlay (`skills.customDirectories`) with the host-level skill
// sources (Pi/Claude/Codex/Agents user dirs) disabled. That keeps each run's
// skill surface scoped to this agent's Paperclip skills — never the operator's
// personal skill libraries — and never accumulates state across runs.
async function buildOmpSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveOmpSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: "omp_local",
    availableEntries,
    desiredSkills,
    configuredDetail: "Will be staged into the per-run OMP skills overlay on the next run.",
    externalInstalled: installed,
    externalLocationLabel: "~/.omp/agent/skills",
    externalDetail: "Installed outside Paperclip management in the OMP skills home.",
    skillsHome,
  });
}

export async function listOmpSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOmpSkillSnapshot(ctx.config);
}

export async function syncOmpSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildOmpSkillSnapshot(ctx.config);
}

export function resolveOmpDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}
