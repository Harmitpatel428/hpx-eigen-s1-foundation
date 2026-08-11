import { PrismaClient, NotificationType } from '@prisma/client';

interface CreateNotificationInput {
  tenantId: string;
  recipientUserId: string;
  type: NotificationType;
  title: string;
  message: string;
  actionUrl?: string;
}

export class NotificationService {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateNotificationInput) {
    return this.prisma.notification.create({ data: input });
  }

  async createMany(inputs: CreateNotificationInput[]) {
    if (inputs.length === 0) return;
    return this.prisma.notification.createMany({ data: inputs });
  }

  async list(
    tenantId: string,
    recipientUserId: string,
    opts: { cursor?: string; limit?: number } = {}
  ) {
    const limit = Math.min(opts.limit ?? 20, 50);
    const where = { tenantId, recipientUserId };

    const notifications = await this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });

    const hasMore = notifications.length > limit;
    if (hasMore) notifications.pop();

    return {
      notifications,
      hasMore,
      nextCursor: hasMore ? notifications[notifications.length - 1]?.id : null,
    };
  }

  async unreadCount(tenantId: string, recipientUserId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { tenantId, recipientUserId, readAt: null },
    });
  }

  async markRead(tenantId: string, recipientUserId: string, notificationId: string) {
    return this.prisma.notification.updateMany({
      where: { id: notificationId, tenantId, recipientUserId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(tenantId: string, recipientUserId: string) {
    return this.prisma.notification.updateMany({
      where: { tenantId, recipientUserId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
