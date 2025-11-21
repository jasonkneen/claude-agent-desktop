import { existsSync, rmSync } from 'fs';
import { join } from 'path';

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;

  // Determine paths based on platform
  let jetbrainsPath;
  let skillsDir;

  if (electronPlatformName === 'darwin') {
    const appPath = join(appOutDir, `${context.packager.appInfo.productFilename}.app`);
    jetbrainsPath = join(
      appPath,
      'Contents/Resources/app.asar.unpacked/out/node_modules/@anthropic-ai/claude-agent-sdk/vendor/claude-code-jetbrains-plugin'
    );
    skillsDir = join(appPath, 'Contents/Resources/app.asar.unpacked/out/.claude/skills');
  } else if (electronPlatformName === 'win32') {
    // Windows: app is in a directory, not a bundle
    jetbrainsPath = join(
      appOutDir,
      'resources/app.asar.unpacked/out/node_modules/@anthropic-ai/claude-agent-sdk/vendor/claude-code-jetbrains-plugin'
    );
    skillsDir = join(appOutDir, 'resources/app.asar.unpacked/out/.claude/skills');
  } else {
    // Linux: similar to Windows structure
    jetbrainsPath = join(
      appOutDir,
      'resources/app.asar.unpacked/out/node_modules/@anthropic-ai/claude-agent-sdk/vendor/claude-code-jetbrains-plugin'
    );
    skillsDir = join(appOutDir, 'resources/app.asar.unpacked/out/.claude/skills');
  }

  // Remove JetBrains plugin (not needed for desktop agent)
  console.log('Removing JetBrains plugin directory...');
  try {
    if (existsSync(jetbrainsPath)) {
      rmSync(jetbrainsPath, { recursive: true, force: true });
      console.log('JetBrains plugin removed successfully');
    } else {
      console.log('JetBrains plugin directory not found, skipping removal');
    }
  } catch (error) {
    console.warn('Could not remove JetBrains plugin:', error.message);
  }

  // Verify .claude/skills directory exists
  if (existsSync(skillsDir)) {
    console.log('.claude/skills directory found at:', skillsDir);
    if (electronPlatformName === 'darwin') {
      console.log('  → electron-builder will codesign binaries automatically');
    }
  } else {
    console.warn('.claude/skills directory not found at expected location:', skillsDir);
  }
}
