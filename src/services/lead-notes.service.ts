import { PrismaClient } from '@prisma/client';

interface TenantContext { tenantId: string; userId: string; }

export class LeadNotesService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create a new lead note
   * - 500 char max (server-side enforced)
   * - XSS-safe: plain text only
   * - Tenant-scoped
   */
  async createNote(
    ctx: TenantContext,
    leadId: string,
    content: string,
    followUpDate?: Date,
    followUpTime?: string
  ) {
    // Validation: content length
    if (!content || content.trim().length === 0) {
      throw { code: 'VALIDATION_ERROR', message: 'Note content is required' };
    }
    if (content.length > 500) {
      throw { code: 'VALIDATION_ERROR', message: 'Note exceeds 500 characters' };
    }

    // Verify Lead exists and belongs to this tenant
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenantId: ctx.tenantId },
    });
    if (!lead) throw { code: 'LEAD_NOT_FOUND' };

    // Validate follow-up if provided
    if (followUpDate && isNaN(followUpDate.getTime())) {
      throw { code: 'VALIDATION_ERROR', message: 'Invalid follow-up date' };
    }
    if (followUpTime && !/^\d{2}:\d{2}$/.test(followUpTime)) {
      throw { code: 'VALIDATION_ERROR', message: 'Invalid follow-up time format (HH:mm)' };
    }

    return this.prisma.leadNote.create({
      data: {
        tenantId: ctx.tenantId,
        leadId,
        authorId: ctx.userId,
        content: content.trim(),
        followUpDate,
        followUpTime,
      },
    });
  }

  /**
   * Update a note - ONLY ALLOWED ON SAME CALENDAR DAY
   * Server-side enforced, not UI-only
   */
  async updateNote(
    ctx: TenantContext,
    noteId: string,
    content?: string,
    followUpDate?: Date | null,
    followUpTime?: string | null
  ) {
    // Fetch note and verify ownership + tenant
    const note = await this.prisma.leadNote.findFirst({
      where: { id: noteId, tenantId: ctx.tenantId },
    });
    if (!note) throw { code: 'NOTE_NOT_FOUND' };

    // **CRITICAL: Same-day edit policy**
    // Verify: TODAY's calendar date === note's creation calendar date
    const today = new Date();
    const noteDate = new Date(note.createdAt);

    // Compare calendar dates (YYYY-MM-DD), not 24-hour windows
    const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const noteDateStr = `${noteDate.getFullYear()}-${String(noteDate.getMonth() + 1).padStart(2, '0')}-${String(noteDate.getDate()).padStart(2, '0')}`;

    if (todayDate !== noteDateStr) {
      throw { code: 'NOTE_EDIT_WINDOW_EXPIRED', message: 'This note can no longer be edited. Notes are only editable on the day they are created.' };
    }

    // Validate content
    if (content && content.length > 500) {
      throw { code: 'VALIDATION_ERROR', message: 'Note exceeds 500 characters' };
    }

    // **CRITICAL: createdAt MUST NEVER CHANGE**
    return this.prisma.leadNote.update({
      where: { id: noteId },
      data: {
        content: content?.trim() || note.content,
        followUpDate: followUpDate === null ? null : (followUpDate || note.followUpDate),
        followUpTime: followUpTime === null ? null : (followUpTime || note.followUpTime),
        updatedAt: new Date(),
        // createdAt is NOT included here - Prisma will not allow changing it
      },
    });
  }

  /**
   * List notes for a Lead, chronologically
   */
  async listNotes(ctx: TenantContext, leadId: string, limit = 100, skip = 0) {
    return this.prisma.leadNote.findMany({
      where: { leadId, tenantId: ctx.tenantId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip,
    });
  }

  /**
   * Soft-delete a note (preserve history)
   */
  async deleteNote(ctx: TenantContext, noteId: string) {
    const note = await this.prisma.leadNote.findFirst({
      where: { id: noteId, tenantId: ctx.tenantId },
    });
    if (!note) throw { code: 'NOTE_NOT_FOUND' };

    return this.prisma.leadNote.update({
      where: { id: noteId },
      data: { deletedAt: new Date() },
    });
  }
}
