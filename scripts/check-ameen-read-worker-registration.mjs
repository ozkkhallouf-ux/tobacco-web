import { readFileSync } from "node:fs";

const registrationPath = "tools/register-ameen-read-worker-task.ps1";
const registration = readFileSync(registrationPath, "utf8");
const worker = readFileSync("tools/ameen-read-worker.ps1", "utf8");
const gateway = readFileSync("tools/ameen-read-gateway.ps1", "utf8");

const requiredRegistrationContracts = [
  ['TaskName', /\$taskName\s*=\s*"TOBACCO Ameen Read Worker"/],
  ['LOQ principal restriction', /\$requiredUser\s*=\s*"LOQ"/],
  ['Password logon', /-LogonType\s+Password/],
  ['limited run level', /-RunLevel\s+Limited/],
  ['worker path', /Join-Path\s+\$PSScriptRoot\s+"ameen-read-worker\.ps1"/],
  ['Windows PowerShell action', /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/],
  ['quoted worker action', /-NoProfile -ExecutionPolicy Bypass -File `"\$workerPath`"/],
  ['repository working directory', /-WorkingDirectory\s+\$repoRoot/],
  ['AtStartup trigger', /New-ScheduledTaskTrigger\s+-AtStartup/],
  ['startup delay matches live task', /\$startupTrigger\.Delay\s*=\s*"PT2M"/],
  // 2026-09-24: الحارس (OZKSync) لا يملك تشغيل مهمة LOQ، فالاستعادة بعد توقف العامل
  // محفّز تكرار في المهمة نفسها — بلا صلاحية جديدة لأي حساب.
  ['10-minute self-recovery trigger', /New-ScheduledTaskTrigger\s+-RepetitionInterval\s+\(New-TimeSpan -Minutes 10\)\s+-Once\s+-At/],
  ['both triggers registered', /-Trigger\s+@\(\$startupTrigger,\s*\$recoveryTrigger\)/],
  ['StartWhenAvailable', /-StartWhenAvailable/],
  ['allow start on batteries', /-AllowStartIfOnBatteries/],
  ['keep running on batteries', /-DontStopIfGoingOnBatteries/],
  ['unlimited execution time', /-ExecutionTimeLimit\s+\(New-TimeSpan -Seconds 0\)/],
  ['IgnoreNew instances', /-MultipleInstances\s+IgnoreNew/],
  ['restart count', /-RestartCount\s+99/],
  ['restart interval', /-RestartInterval\s+\(New-TimeSpan -Minutes 1\)/],
  ['secure password prompt', /Read-Host[^\n]+-AsSecureString/],
  ['password memory cleanup', /ZeroFreeBSTR\(\$passwordPointer\)/],
  ['existing-task refusal', /Scheduled task already exists/],
];

for (const [name, pattern] of requiredRegistrationContracts) {
  if (!pattern.test(registration)) {
    throw new Error(`Ameen Read Worker registration contract missing: ${name}`);
  }
}

const executableLines = registration
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

if (/Start-ScheduledTask/i.test(executableLines)) {
  throw new Error("Registration script must never start the scheduled task.");
}
if (/Start-Process|&\s*\$workerPath|\.\s*\$workerPath/i.test(executableLines)) {
  throw new Error("Registration script must never start the worker directly.");
}
if (/\b(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b/i.test(executableLines)) {
  throw new Error("Registration script must not modify the worker or any repository file.");
}
if (/\b(?:Unregister-ScheduledTask|Set-ScheduledTask)\b/i.test(executableLines)) {
  throw new Error("Registration script must not delete or mutate an existing task definition.");
}
if (/\b(?:SYSTEM|OZKSync)\b/i.test(executableLines)) {
  throw new Error("Registration script must not switch the worker to SYSTEM or OZKSync.");
}
if (/sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}|postgres(?:ql)?:\/\/|Password\s*=\s*["'][^$]/i.test(registration)) {
  throw new Error("Registration script appears to contain an embedded credential or connection string.");
}

for (const environmentName of [
  "TOBACCO_SUPABASE_URL",
  "TOBACCO_SUPABASE_PUBLIC_KEY",
  "TOBACCO_SYNC_EMAIL",
  "TOBACCO_SYNC_PASSWORD",
  "AMEEN_SQL_CONNECTION_STRING",
]) {
  if (!registration.includes(`"${environmentName}"`)) {
    throw new Error(`Registration script must validate ${environmentName} without embedding its value.`);
  }
}

if (!gateway.includes('[ValidateSet("health","stock","customers")]')) {
  throw new Error("Ameen Read Gateway resources changed.");
}
if (!gateway.includes("Assert-ReadOnlySql")) {
  throw new Error("Ameen SQL read-only guard is missing.");
}
if (!worker.includes('[System.Text.Encoding]::UTF8.GetBytes($json)')) {
  throw new Error("Ameen Read Worker UTF-8 transport contract changed.");
}

console.log("Ameen Read Worker registration contract: OK");
