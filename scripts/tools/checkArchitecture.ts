import fs from 'node:fs';
import path from 'node:path';

const MAX_NEW_FILE_LINES = 400;
const ROOT = process.cwd();
const BASELINE_PATH = path.join(ROOT, 'architecture-baseline.json');

interface Baseline {
  caps: Record<string, number>;
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

function countLines(file: string): number {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
}

/**
 * Presupuesto de tamano: archivos nuevos <=400 lineas.
 * Los legacy solo pueden tener el cap declarado en architecture-baseline.json
 * y ese cap nunca puede subir.
 */
export function checkArchitectureBudget(): { passed: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!fs.existsSync(BASELINE_PATH)) {
    return { passed: false, issues: ['Falta architecture-baseline.json en la raiz.'] };
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  const caps = baseline.caps ?? {};
  const seen = new Set<string>();

  for (const file of walk(path.join(ROOT, 'src'))) {
    const relative = path.relative(ROOT, file).replace(/\\/g, '/');
    const lines = countLines(file);
    const cap = caps[relative];

    if (cap !== undefined) {
      seen.add(relative);
      if (lines > cap) {
        issues.push(`${relative}: ${lines} lineas > cap legacy ${cap}. No puede crecer.`);
      } else if (lines < cap && lines > MAX_NEW_FILE_LINES) {
        issues.push(
          `${relative}: ${lines} lineas. Baja el cap legacy (${cap}) a ${lines} en architecture-baseline.json.`
        );
      } else if (lines <= MAX_NEW_FILE_LINES) {
        issues.push(
          `${relative}: ${lines} lineas. Ya esta bajo 400; elimina su entrada del baseline.`
        );
      }
      continue;
    }

    if (lines > MAX_NEW_FILE_LINES) {
      issues.push(`${relative}: ${lines} lineas > ${MAX_NEW_FILE_LINES}. Extrae una responsabilidad.`);
    }
  }

  for (const stale of Object.keys(caps)) {
    if (!seen.has(stale)) {
      issues.push(`${stale}: cap en baseline pero el archivo no existe o ya no aplica.`);
    }
  }

  return { passed: issues.length === 0, issues };
}

if (process.argv[1]?.endsWith('checkArchitecture.ts')) {
  const result = checkArchitectureBudget();
  if (result.passed) {
    console.log('✔ Presupuesto de arquitectura respetado.');
    process.exit(0);
  }
  console.error('✖ Violaciones de presupuesto de arquitectura:');
  result.issues.forEach((issue) => console.error(`  - ${issue}`));
  process.exit(1);
}
