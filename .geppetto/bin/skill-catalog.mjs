export * from '../../skills/geppetto-adopt/scripts/skill-catalog.mjs';
import * as script from '../../skills/geppetto-adopt/scripts/skill-catalog.mjs';
import { cli, isMain } from '../../skills/geppetto-adopt/scripts/common.mjs';
if (isMain(import.meta.url) && script.main) await cli(script.main);
