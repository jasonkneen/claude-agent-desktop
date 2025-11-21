import { existsSync } from 'fs';
import { createRequire } from 'module';
import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { BrowserWindow } from 'electron';

import type { ChatModelPreference } from '../../shared/types/ipc';
import {
  buildClaudeSessionEnv,
  getApiKey,
  getChatModelPreferenceSetting,
  getDebugMode,
  getWorkspaceDir,
  setChatModelPreferenceSetting
} from './config';
import {
  abortGenerator,
  clearMessageQueue,
  messageGenerator,
  regenerateSessionId,
  resetAbortFlag,
  setSessionId
} from './message-queue';

const requireModule = createRequire(import.meta.url);

const FAST_MODEL_ID = 'claude-haiku-4-5-20251001';
const SMART_MODEL_ID = 'claude-sonnet-4-5-20250929';

const MODEL_BY_PREFERENCE: Record<ChatModelPreference, string> = {
  fast: FAST_MODEL_ID,
  smart: SMART_MODEL_ID
};

let currentModelPreference: ChatModelPreference = getChatModelPreferenceSetting();

function resolveClaudeCodeCli(): string {
  const cliPath = requireModule.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
  if (cliPath.includes('app.asar')) {
    const unpackedPath = cliPath.replace('app.asar', 'app.asar.unpacked');
    if (existsSync(unpackedPath)) {
      return unpackedPath;
    }
  }
  return cliPath;
}

/**
 * System prompt append for Claude Agent Desktop tooling preferences.
 */
const SYSTEM_PROMPT_APPEND = `**Workspace Context:**
This is a multi-purpose workspace for diverse projects, scripts, and workflows—not a single monolithic codebase. Each subdirectory may represent different applications or tasks. Always understand context before making assumptions about project structure.

**Tooling preferences:**
- JavaScript/TypeScript: Use bun (not node/npm/npx).
- Python: Use uv (not python/pip/conda). Write scripts to files (e.g., temp.py) instead of inline -c commands and run with uv run --with <deps> script.py.

**Memory:**
Maintain \`CLAUDE.md\` in the workspace root as your persistent memory. Update continuously (not just when asked) with: database schemas, project patterns, code snippets, user preferences, and anything useful for future tasks.`;

let querySession: Query | null = null;
let isProcessing = false;
let shouldAbortSession = false;
let sessionTerminationPromise: Promise<void> | null = null;
let isInterruptingResponse = false;
// Map stream index to tool ID for current message
const streamIndexToToolId: Map<number, string> = new Map();
let pendingResumeSessionId: string | null = null;

function getModelIdForPreference(preference: ChatModelPreference = currentModelPreference): string {
  return MODEL_BY_PREFERENCE[preference] ?? FAST_MODEL_ID;
}

export function getCurrentModelPreference(): ChatModelPreference {
  return currentModelPreference;
}

export async function setChatModelPreference(preference: ChatModelPreference): Promise<void> {
  if (preference === currentModelPreference) {
    return;
  }

  const previousPreference = currentModelPreference;
  currentModelPreference = preference;

  if (querySession) {
    try {
      await querySession.setModel(getModelIdForPreference(preference));
    } catch (error) {
      currentModelPreference = previousPreference;
      console.error('Failed to update Claude model preference:', error);
      throw error;
    }
  }

  setChatModelPreferenceSetting(currentModelPreference);
}

export function isSessionActive(): boolean {
  return isProcessing || querySession !== null;
}

export async function interruptCurrentResponse(mainWindow: BrowserWindow | null): Promise<boolean> {
  if (!querySession) {
    return false;
  }

  if (isInterruptingResponse) {
    return true;
  }

  isInterruptingResponse = true;
  try {
    await querySession.interrupt();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:message-stopped');
    }
    return true;
  } catch (error) {
    console.error('Failed to interrupt current response:', error);
    throw error;
  } finally {
    isInterruptingResponse = false;
  }
}

export async function resetSession(resumeSessionId?: string | null): Promise<void> {
  // Signal any running session to abort
  shouldAbortSession = true;

  // Signal the message generator to abort
  abortGenerator();

  // Clear the message queue to prevent pending messages from being sent
  clearMessageQueue();

  // Generate or set the appropriate session ID for the next conversation
  regenerateSessionId(resumeSessionId ?? null);
  pendingResumeSessionId = resumeSessionId ?? null;

  // Wait for the current session to fully terminate before proceeding
  if (sessionTerminationPromise) {
    await sessionTerminationPromise;
  }

  // Clear session state
  querySession = null;
  isProcessing = false;
  sessionTerminationPromise = null;
}

// Start streaming session
export async function startStreamingSession(mainWindow: BrowserWindow | null): Promise<void> {
  // Wait for any pending session termination to complete first
  if (sessionTerminationPromise) {
    await sessionTerminationPromise;
  }

  if (isProcessing || querySession) {
    return;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('API key is not configured');
  }

  // Reset abort flags for new session
  shouldAbortSession = false;
  resetAbortFlag();
  isProcessing = true;
  // Clear stream index mapping for new session
  streamIndexToToolId.clear();

  // Create a promise that resolves when this session terminates
  let resolveTermination: () => void;
  sessionTerminationPromise = new Promise((resolve) => {
    resolveTermination = resolve;
  });

  try {
    // Use the shared environment builder to ensure consistency across Electron app,
    // Claude Agent SDK, and debug panel
    const env = buildClaudeSessionEnv();

    // Ensure API key is set (buildClaudeSessionEnv uses getApiKey which may return null)
    // but we've already checked it exists above, so set it explicitly
    env.ANTHROPIC_API_KEY = apiKey;

    const resumeSessionId = pendingResumeSessionId;
    const isResumedSession = typeof resumeSessionId === 'string' && resumeSessionId.length > 0;
    pendingResumeSessionId = null;

    const modelId = getModelIdForPreference();

    querySession = query({
      prompt: messageGenerator(),
      options: {
        model: modelId,
        maxThinkingTokens: 32_000,
        settingSources: ['project'],
        permissionMode: 'acceptEdits',
        allowedTools: ['Bash', 'WebFetch', 'WebSearch', 'Skill'],
        pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
        executable: 'bun',
        env,
        stderr: (message: string) => {
          // Only send debug messages if debug mode is enabled
          if (getDebugMode() && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('chat:debug-message', message);
          }
        },
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: SYSTEM_PROMPT_APPEND
        },
        cwd: getWorkspaceDir(),
        includePartialMessages: true,
        ...(isResumedSession && { resume: resumeSessionId! })
      }
    });

    // Process streaming responses
    for await (const sdkMessage of querySession) {
      // Check if session should be aborted
      if (shouldAbortSession) {
        break;
      }

      if (!mainWindow || mainWindow.isDestroyed()) {
        break;
      }

      if (sdkMessage.type === 'stream_event') {
        // Handle streaming events
        const streamEvent = sdkMessage.event;
        if (streamEvent.type === 'content_block_delta') {
          if (streamEvent.delta.type === 'text_delta') {
            // Regular text delta
            mainWindow.webContents.send('chat:message-chunk', streamEvent.delta.text);
          } else if (streamEvent.delta.type === 'thinking_delta') {
            // Thinking text delta - send as thinking chunk
            mainWindow.webContents.send('chat:thinking-chunk', {
              index: streamEvent.index,
              delta: streamEvent.delta.thinking
            });
          } else if (streamEvent.delta.type === 'input_json_delta') {
            // Handle input JSON deltas for tool use
            // Look up the tool ID for this stream index
            const toolId = streamIndexToToolId.get(streamEvent.index);
            mainWindow.webContents.send('chat:tool-input-delta', {
              index: streamEvent.index,
              toolId: toolId || '', // Send tool ID if available
              delta: streamEvent.delta.partial_json
            });
          }
        } else if (streamEvent.type === 'content_block_start') {
          // Handle thinking blocks
          if (streamEvent.content_block.type === 'thinking') {
            mainWindow.webContents.send('chat:thinking-start', {
              index: streamEvent.index
            });
          } else if (streamEvent.content_block.type === 'tool_use') {
            // Store mapping of stream index to tool ID
            streamIndexToToolId.set(streamEvent.index, streamEvent.content_block.id);

            mainWindow.webContents.send('chat:tool-use-start', {
              id: streamEvent.content_block.id,
              name: streamEvent.content_block.name,
              input: streamEvent.content_block.input || {},
              streamIndex: streamEvent.index
            });
          } else if (
            (streamEvent.content_block.type === 'web_search_tool_result' ||
              streamEvent.content_block.type === 'web_fetch_tool_result' ||
              streamEvent.content_block.type === 'code_execution_tool_result' ||
              streamEvent.content_block.type === 'bash_code_execution_tool_result' ||
              streamEvent.content_block.type === 'text_editor_code_execution_tool_result' ||
              streamEvent.content_block.type === 'mcp_tool_result') &&
            'tool_use_id' in streamEvent.content_block
          ) {
            // Handle tool result blocks starting - these are the actual tool result types
            const toolResultBlock = streamEvent.content_block as {
              tool_use_id: string;
              content?: string | unknown;
              is_error?: boolean;
            };

            let contentStr = '';
            if (typeof toolResultBlock.content === 'string') {
              contentStr = toolResultBlock.content;
            } else if (toolResultBlock.content !== null && toolResultBlock.content !== undefined) {
              contentStr = JSON.stringify(toolResultBlock.content, null, 2);
            }

            if (contentStr) {
              mainWindow.webContents.send('chat:tool-result-start', {
                toolUseId: toolResultBlock.tool_use_id,
                content: contentStr,
                isError: toolResultBlock.is_error || false
              });
            }
          }
        } else if (streamEvent.type === 'content_block_stop') {
          // Signal end of a content block
          // Look up tool ID for this stream index (if it's a tool block)
          const toolId = streamIndexToToolId.get(streamEvent.index);
          mainWindow.webContents.send('chat:content-block-stop', {
            index: streamEvent.index,
            toolId: toolId || undefined
          });
        }
      } else if (sdkMessage.type === 'assistant') {
        // Handle complete assistant messages - extract tool results
        const assistantMessage = sdkMessage.message;
        if (assistantMessage.content) {
          for (const block of assistantMessage.content) {
            // Check for tool result blocks (SDK uses specific types like web_search_tool_result, etc.)
            // These blocks have tool_use_id and content properties
            if (
              typeof block === 'object' &&
              block !== null &&
              'tool_use_id' in block &&
              'content' in block
            ) {
              // Type guard for tool_result-like blocks
              // Content contains ToolOutput types (BashOutput, ReadOutput, GrepOutput, etc.)
              // which are structured objects describing the tool's result
              const toolResultBlock = block as {
                tool_use_id: string;
                content: string | unknown[] | unknown;
                is_error?: boolean;
              };

              // Convert content to string representation
              // Content can be:
              // - A string (for simple text results)
              // - An array of content blocks (text, images, etc.) from Anthropic API
              // - A structured ToolOutput object (BashOutput, ReadOutput, GrepOutput, etc.)
              let contentStr: string;
              if (typeof toolResultBlock.content === 'string') {
                contentStr = toolResultBlock.content;
              } else if (Array.isArray(toolResultBlock.content)) {
                // Array of content blocks - extract text from each
                contentStr = toolResultBlock.content
                  .map((c) => {
                    if (typeof c === 'string') {
                      return c;
                    }
                    if (typeof c === 'object' && c !== null) {
                      // Could be text block, image block, etc.
                      if ('text' in c && typeof c.text === 'string') {
                        return c.text;
                      }
                      if ('type' in c && c.type === 'text' && 'text' in c) {
                        return String(c.text);
                      }
                      // For other types, stringify
                      return JSON.stringify(c, null, 2);
                    }
                    return String(c);
                  })
                  .join('\n');
              } else if (
                typeof toolResultBlock.content === 'object' &&
                toolResultBlock.content !== null
              ) {
                // Structured ToolOutput object (e.g., BashOutput with output/exitCode,
                // ReadOutput with content/total_lines, GrepOutput with matches, etc.)
                // Stringify as JSON - the renderer will format it nicely
                contentStr = JSON.stringify(toolResultBlock.content, null, 2);
              } else {
                contentStr = String(toolResultBlock.content);
              }

              // Send tool result - this will be displayed in the UI
              mainWindow.webContents.send('chat:tool-result-complete', {
                toolUseId: toolResultBlock.tool_use_id,
                content: contentStr,
                isError: toolResultBlock.is_error || false
              });
            }
          }
        }
        // Don't signal completion here - agent may still be running tools
      } else if (sdkMessage.type === 'result') {
        // Final result message - this is when the agent is truly done
        mainWindow.webContents.send('chat:message-complete');
      } else if (sdkMessage.type === 'system') {
        if (sdkMessage.subtype === 'init') {
          const sessionIdFromSdk = sdkMessage.session_id;
          if (sessionIdFromSdk) {
            setSessionId(sessionIdFromSdk);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('chat:session-updated', {
                sessionId: sessionIdFromSdk,
                resumed: isResumedSession
              });
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in streaming session:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      mainWindow.webContents.send('chat:message-error', errorMessage);
    }
  } finally {
    isProcessing = false;
    querySession = null;

    // Resolve the termination promise to signal session has ended
    resolveTermination!();
  }
}
