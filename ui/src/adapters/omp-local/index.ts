import type { UIAdapterModule } from "../types";
import { parseOmpStdoutLine } from "@paperclipai/adapter-omp-local/ui";
import { OmpLocalConfigFields } from "./config-fields";
import { buildOmpLocalConfig } from "@paperclipai/adapter-omp-local/ui";

export const ompLocalUIAdapter: UIAdapterModule = {
  type: "omp_local",
  label: "OMP",
  parseStdoutLine: parseOmpStdoutLine,
  ConfigFields: OmpLocalConfigFields,
  buildAdapterConfig: buildOmpLocalConfig,
};
