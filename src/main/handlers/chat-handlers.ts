import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { join, relative } from 'path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ipcMain, type BrowserWindow } from 'electron';

import { ATTACHMENTS_DIR_NAME, MAX_ATTACHMENT_BYTES } from '../../shared/constants';
import type {
  ChatModelPreference,
  SavedAttachmentInfo,
  SendMessagePayload,
  SerializedAttachmentPayload
} from '../../shared/types/ipc';
import {
  getCurrentModelPreference,
  interruptCurrentResponse,
  isSessionActive,
  resetSession,
  setChatModelPreference,
  startStreamingSession
} from '../lib/claude-session';
import { getApiKey, getWorkspaceDir } from '../lib/config';
import { messageQueue } from '../lib/message-queue';

export function registerChatHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('chat:send-message', async (_event, payload: SendMessagePayload) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      return {
        success: false,
        error:
          'API key is not configured. Add your Anthropic API key in Settings or set ANTHROPIC_API_KEY.'
      };
    }

    const normalizedPayload = payload ?? { text: '', attachments: [] };
    const text = normalizedPayload.text?.trim() ?? '';
    const attachments = normalizedPayload.attachments ?? [];

    if (!text && attachments.length === 0) {
      return { success: false, error: 'Please enter a message or attach a file before sending.' };
    }

    try {
      const savedAttachments = await persistAttachments(attachments);

      const userMessage = buildUserMessage(text, savedAttachments);

      // Start streaming session if not already running
      if (!isSessionActive()) {
        startStreamingSession(getMainWindow()).catch((error) => {
          console.error('Failed to start streaming session:', error);
        });
      }

      // Queue the message
      await new Promise<void>((resolve) => {
        messageQueue.push({ message: userMessage, resolve });
      });

      return { success: true, attachments: savedAttachments };
    } catch (error) {
      console.error('Error queueing message:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle('chat:reset-session', async (_event, resumeSessionId?: string | null) => {
    try {
      await resetSession(resumeSessionId);
      return { success: true };
    } catch (error) {
      console.error('Error resetting session:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle('chat:stop-message', async () => {
    try {
      const mainWindow = getMainWindow();
      const wasInterrupted = await interruptCurrentResponse(mainWindow);
      if (!wasInterrupted) {
        return { success: false, error: 'No active response to stop.' };
      }
      return { success: true };
    } catch (error) {
      console.error('Error stopping response:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle('chat:get-model-preference', async () => {
    return {
      preference: getCurrentModelPreference()
    };
  });

  ipcMain.handle('chat:set-model-preference', async (_event, preference: ChatModelPreference) => {
    try {
      await setChatModelPreference(preference);
      return { success: true, preference: getCurrentModelPreference() };
    } catch (error) {
      console.error('Error updating model preference:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return { success: false, error: errorMessage, preference: getCurrentModelPreference() };
    }
  });
}

function sanitizeFileName(name: string): string {
  const withoutIllegal = name.replace(/[<>:"/\\|?*]/g, '_');
  const withoutControlChars = Array.from(withoutIllegal)
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('');
  return withoutControlChars.replace(/\s+/g, ' ').trim() || 'attachment';
}

async function persistAttachments(
  attachments: SerializedAttachmentPayload[]
): Promise<SavedAttachmentInfo[]> {
  if (attachments.length === 0) {
    return [];
  }

  const workspaceDir = getWorkspaceDir();
  const destinationDir = join(workspaceDir, ATTACHMENTS_DIR_NAME);
  await mkdir(destinationDir, { recursive: true });

  const saves: SavedAttachmentInfo[] = [];

  for (const attachment of attachments) {
    if (attachment.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment "${attachment.name}" exceeds the ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit.`
      );
    }

    const sanitized = sanitizeFileName(attachment.name);
    const uniqueName = `${Date.now()}-${randomUUID().slice(0, 8)}-${sanitized}`;
    const savedPath = join(destinationDir, uniqueName);

    const buffer =
      attachment.data instanceof Uint8Array ?
        Buffer.from(attachment.data.buffer, attachment.data.byteOffset, attachment.data.byteLength)
      : Buffer.from(attachment.data);

    await writeFile(savedPath, buffer);

    const relativePath = relative(workspaceDir, savedPath);

    saves.push({
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      savedPath,
      relativePath: relativePath.startsWith('..') ? savedPath : relativePath
    });
  }

  return saves;
}

function buildUserMessage(
  text: string,
  attachments: SavedAttachmentInfo[]
): SDKUserMessage['message'] {
  const contentBlocks: { type: 'text'; text: string }[] = [];
  if (text) {
    contentBlocks.push({ type: 'text', text });
  }

  attachments.forEach((attachment) => {
    const relativeSegment = attachment.relativePath;
    const relativeWithinWorkspace =
      relativeSegment && !relativeSegment.startsWith('..') ? relativeSegment : null;
    const readTarget =
      relativeWithinWorkspace ?
        relativeWithinWorkspace.startsWith('.') ?
          relativeWithinWorkspace
        : `./${relativeWithinWorkspace}`
      : attachment.savedPath;
    const displayPath = relativeWithinWorkspace ? readTarget : attachment.savedPath;
    const instruction = `Attachment "${attachment.name}" is available at ${displayPath}. Please run Read("${readTarget}") when you need to inspect it.`;
    contentBlocks.push({ type: 'text', text: instruction });
  });

  if (contentBlocks.length === 0) {
    contentBlocks.push({
      type: 'text',
      text: 'User uploaded files without additional context.'
    });
  }

  return {
    role: 'user',
    content: contentBlocks
  };
}
