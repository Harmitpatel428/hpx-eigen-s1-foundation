import { PrismaClient, UserStatus } from '@prisma/client';
import { BaseRepository, TenantContext } from './base.repo';
import { ResourceNotFoundError, DuplicateResourceError } from '../types/exceptions';

export class UserRepository extends BaseRepository {
  private prisma: PrismaClient;

  constructor(ctx: TenantContext, prisma: PrismaClient) {
    super(ctx);
    this.prisma = prisma;
  }

  async findByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: {
        ...this.buildTenantFilter(),
        email
      }
    });
  }

  async findById(id: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        ...this.buildTenantFilter(),
        id
      }
    });

    if (!user) throw new ResourceNotFoundError();
    return user;
  }

  async create(email: string, password: string) {
    const existing = await this.findByEmail(email);
    if (existing) throw new DuplicateResourceError();

    return this.prisma.user.create({
      data: {
        tenantId: this.ctx.tenantId,
        email,
        password,
        status: UserStatus.NEW
      }
    });
  }

  async updateStatus(userId: string, status: UserStatus) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { status }
    });
  }

  async listActive() {
    return this.prisma.user.findMany({
      where: {
        ...this.buildTenantFilter(),
        status: UserStatus.ACTIVE
      }
    });
  }
}
