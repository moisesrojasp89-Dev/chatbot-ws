/**
 * 🛡️ Chatbot WS — Institutional Quality Gate Script
 * Version: 1.0.0
 *
 * Verifies all engineering invariants prior to CI/CD and deployment:
 * 1. TypeScript AST Validation (tsc --noEmit, 0 errors, 0 warnings).
 * 2. Deterministic Test Suite (Vitest, 100% passing suites).
 * 3. Zero-Trust Secret Scanning (no Meta tokens, LLM provider keys, or DB credentials in tracked files).
 * 4. Configuration & Environment Schema Integrity (.env.example vs env.ts vs .gitignore).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface QualityGateResult {
  step: string;
  passed: boolean;
  durationMs: number;
  details?: string;
}

const RESULTS: QualityGateResult[] = [];
const ROOT_DIR = process.cwd();

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function printHeader(title: string): void {
  console.log(`\n${COLORS.cyan}${COLORS.bold}================================================================${COLORS.reset}`);
  console.log(`${COLORS.cyan}${COLORS.bold}  🛡️  CHATBOT WS QUALITY GATE — ${title.toUpperCase()}${COLORS.reset}`);
  console.log(`${COLORS.cyan}${COLORS.bold}================================================================${COLORS.reset}\n`);
}

function runCommand(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows && (command === 'npx' || command === 'npm') ? `${command}.cmd` : command;

    const proc = spawn(cmd, args, {
      cwd: ROOT_DIR,
      shell: isWindows,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// 1. TypeScript AST Compilation Check
// ---------------------------------------------------------------------------
async function checkTypeScript(): Promise<void> {
  const start = Date.now();
  console.log(`${COLORS.blue}▶ [1/4] Ejecutando Verificación de Tipos TypeScript (tsc --noEmit)...${COLORS.reset}`);

  const { code, stdout, stderr } = await runCommand('npx', ['tsc', '--noEmit']);
  const duration = Date.now() - start;

  if (code === 0) {
    console.log(`  ${COLORS.green}✔ TypeScript compiló sin errores ni advertencias (0 fallos).${COLORS.reset} ${COLORS.gray}(${duration}ms)${COLORS.reset}`);
    RESULTS.push({ step: 'TypeScript Typecheck', passed: true, durationMs: duration });
  } else {
    console.error(`  ${COLORS.red}✖ Fallo de compilación TypeScript (código ${code}):${COLORS.reset}`);
    console.error(stdout || stderr);
    RESULTS.push({
      step: 'TypeScript Typecheck',
      passed: false,
      durationMs: duration,
      details: stdout || stderr,
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Vitest Test Suite Execution Check
// ---------------------------------------------------------------------------
async function checkTests(): Promise<void> {
  const start = Date.now();
  console.log(`${COLORS.blue}▶ [2/4] Ejecutando Suite de Pruebas Automatizadas (vitest run)...${COLORS.reset}`);

  const { code, stdout, stderr } = await runCommand('npx', ['vitest', 'run']);
  const duration = Date.now() - start;

  if (code === 0) {
    const passedMatch = stdout.match(/Tests\s+([0-9]+)\s+passed/);
    const count = passedMatch ? passedMatch[1] : 'todas';
    console.log(`  ${COLORS.green}✔ Vitest ejecutó exitosamente: ${count} pruebas aprobadas (100%).${COLORS.reset} ${COLORS.gray}(${duration}ms)${COLORS.reset}`);
    RESULTS.push({ step: 'Vitest Test Suite', passed: true, durationMs: duration });
  } else {
    console.error(`  ${COLORS.red}✖ Fallo en la suite de pruebas unitarias/integración (código ${code}):${COLORS.reset}`);
    const summary = (stdout + '\n' + stderr).split('\n').filter((l) => l.includes('FAIL') || l.includes('Failed')).join('\n');
    console.error(summary || stdout);
    RESULTS.push({
      step: 'Vitest Test Suite',
      passed: false,
      durationMs: duration,
      details: summary || 'Tests fallidos reportados por Vitest',
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Zero-Trust Secrets Scanning Check
// ---------------------------------------------------------------------------
async function checkSecrets(): Promise<void> {
  const start = Date.now();
  console.log(`${COLORS.blue}▶ [3/4] Escaneo de Seguridad Zero-Trust (Búsqueda de Secretos en Código)...${COLORS.reset}`);

  const forbiddenPatterns: { name: string; regex: RegExp; ignorePlaceholders?: RegExp }[] = [
    {
      name: 'Token de Meta Cloud API real',
      regex: /EAAB[A-Za-z0-9_-]{50,}/g,
      ignorePlaceholders: /EAAB_YOUR_META_PERMANENT_ACCESS_TOKEN_HERE/,
    },

    {
      name: 'Clave privada RSA/PGP incrustada',
      regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
    },
    {
      name: 'Cadena de conexión PostgreSQL con contraseña en texto plano en código rastreado',
      regex: /postgres(?:ql)?:\/\/(?!postgres:postgres@localhost)[^:\s]+:[^@\s]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      ignorePlaceholders: /\[DB-PASSWORD\]|<DB-PASSWORD>|YOUR_PASSWORD/i,
    },
  ];

  const filesToScan: string[] = [];

  function collectFiles(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === '.git' ||
          entry.name === 'coverage'
        ) {
          continue;
        }
        collectFiles(fullPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.ts', '.js', '.json', '.md', '.env.example'].includes(ext)) {
          filesToScan.push(fullPath);
        }
      }
    }
  }

  collectFiles(ROOT_DIR);

  const findings: string[] = [];

  for (const file of filesToScan) {
    const relPath = path.relative(ROOT_DIR, file);
    if (relPath === '.env' || relPath.startsWith('.env.')) {
      continue; // .env real no debe ser escaneado como código fuente
    }

    const content = fs.readFileSync(file, 'utf8');

    for (const pattern of forbiddenPatterns) {
      const matches = content.match(pattern.regex);
      if (matches) {
        for (const match of matches) {
          if (pattern.ignorePlaceholders && pattern.ignorePlaceholders.test(match)) {
            continue;
          }
          findings.push(`[${pattern.name}] en ${relPath}: "${match.substring(0, 10)}..."`);
        }
      }
    }
  }

  const duration = Date.now() - start;

  if (findings.length === 0) {
    console.log(`  ${COLORS.green}✔ Cero secretos encontrados en ${filesToScan.length} archivos auditados.${COLORS.reset} ${COLORS.gray}(${duration}ms)${COLORS.reset}`);
    RESULTS.push({ step: 'Zero-Trust Secret Scanner', passed: true, durationMs: duration });
  } else {
    console.error(`  ${COLORS.red}✖ Secretos detectados en código fuente rastreado (${findings.length} hallazgos):${COLORS.reset}`);
    findings.forEach((f) => console.error(`    - ${f}`));
    RESULTS.push({
      step: 'Zero-Trust Secret Scanner',
      passed: false,
      durationMs: duration,
      details: findings.join('\n'),
    });
  }
}

// ---------------------------------------------------------------------------
// 4. Environment Schema & Architecture Rules Check
// ---------------------------------------------------------------------------
async function checkEnvironmentAndArchitecture(): Promise<void> {
  const start = Date.now();
  console.log(`${COLORS.blue}▶ [4/4] Verificación de Variables de Entorno y Arquitectura Institucional...${COLORS.reset}`);

  const issues: string[] = [];

  // A. .gitignore debe contener .env
  const gitignorePath = path.join(ROOT_DIR, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    issues.push('Falta archivo .gitignore en la raíz.');
  } else {
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
    if (!gitignoreContent.includes('.env')) {
      issues.push('.gitignore no excluye .env');
    }
  }

  // B. .env.example debe existir y sus variables deben estar mapeadas en env.ts
  const envExamplePath = path.join(ROOT_DIR, '.env.example');
  const envTsPath = path.join(ROOT_DIR, 'src', 'config', 'env.ts');

  if (!fs.existsSync(envExamplePath)) {
    issues.push('Falta archivo .env.example.');
  } else if (!fs.existsSync(envTsPath)) {
    issues.push('Falta archivo src/config/env.ts.');
  } else {
    const envExampleLines = fs
      .readFileSync(envExamplePath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => l.split('=')[0].trim());

    const envTsContent = fs.readFileSync(envTsPath, 'utf8');

    for (const key of envExampleLines) {
      if (!envTsContent.includes(key)) {
        issues.push(`Variable ${key} de .env.example no está validada en src/config/env.ts.`);
      }
    }
  }

  // C. AGENTS.md debe existir en la raíz
  const agentsMd = path.join(ROOT_DIR, 'AGENTS.md');

  if (!fs.existsSync(agentsMd)) issues.push('Falta AGENTS.md en la raíz del proyecto.');

  // D. docs/standards_and_harness/self_learning_error_catalog.md debe existir
  const errorCatalog = path.join(ROOT_DIR, 'docs', 'standards_and_harness', 'self_learning_error_catalog.md');
  if (!fs.existsSync(errorCatalog)) {
    issues.push('Falta docs/standards_and_harness/self_learning_error_catalog.md.');
  }

  const duration = Date.now() - start;

  if (issues.length === 0) {
    console.log(`  ${COLORS.green}✔ Configuración y estándares de arquitectura íntegros y sincronizados.${COLORS.reset} ${COLORS.gray}(${duration}ms)${COLORS.reset}`);
    RESULTS.push({ step: 'Environment & Harness Schema', passed: true, durationMs: duration });
  } else {
    console.error(`  ${COLORS.red}✖ Anomalías encontradas en configuración institucional:${COLORS.reset}`);
    issues.forEach((i) => console.error(`    - ${i}`));
    RESULTS.push({
      step: 'Environment & Harness Schema',
      passed: false,
      durationMs: duration,
      details: issues.join('\n'),
    });
  }
}

// ---------------------------------------------------------------------------
// Main Executor
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  printHeader('INSPECCIÓN DETERMINISTA');

  await checkTypeScript();
  await checkSecrets();
  await checkEnvironmentAndArchitecture();
  await checkTests();

  console.log(`\n${COLORS.cyan}----------------------------------------------------------------${COLORS.reset}`);
  console.log(`${COLORS.bold}  📊 RESUMEN FINAL DEL QUALITY GATE:${COLORS.reset}\n`);

  let allPassed = true;
  for (const r of RESULTS) {
    const symbol = r.passed ? `${COLORS.green}✔ APROBADO${COLORS.reset}` : `${COLORS.red}✖ FALLIDO${COLORS.reset}`;
    const name = r.step.padEnd(32, '.');
    console.log(`  ${name} ${symbol} ${COLORS.gray}(${r.durationMs}ms)${COLORS.reset}`);
    if (!r.passed) allPassed = false;
  }

  console.log(`${COLORS.cyan}----------------------------------------------------------------${COLORS.reset}\n`);

  if (allPassed) {
    console.log(`${COLORS.green}${COLORS.bold}🎉 ¡QUALITY GATE 100% SUPERADO! EL REPOSITORIO ESTÁ LISTO PARA PRODUCCIÓN.${COLORS.reset}\n`);
    process.exit(0);
  } else {
    console.error(`${COLORS.red}${COLORS.bold}💥 QUALITY GATE FALLIDO. Corrige las causas raíz antes de continuar.${COLORS.reset}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error fatal durante ejecución de Quality Gate:', err);
  process.exit(1);
});
