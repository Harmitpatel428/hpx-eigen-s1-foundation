// @ts-nocheck
import { PrismaClient, UserStatus, Prisma } from '@prisma/client';
import { BaseRepository, TenantContext } from './base.repo';
import { ResourceNotFoundError, DuplicateResourceError } from '../types/exceptions';

export class UserRepository extends BaseRepository {
  private prisma: PrismaClient;

  constructor(ctx: TenantContext, prisma: PrismaClient) {
    super(ctx);
    this.prisma = prisma;
  }

  async findByEmail(tx: PrismaClient, email: string) {
    return tx.user.findFirst({
      where: {
        ...this.buildTenantFilter(tx),
        email
      }
    });
  }

  async findById(tx: PrismaClient, id: string) {
    const user = await tx.user.findFirst({
      where: {
        ...this.buildTenantFilter(tx),
        id
      }
    });

    if (!user) throw new ResourceNotFoundError();
    return user;
  }

  async create(tx: PrismaClient, email: string, password: string) {
    const existing = await this.findByEmail(tx, email);
    if (existing) throw new DuplicateResourceError();

    return tx.user.create({
      data: {
        tenantId: this.ctx.tenantId,
        email,
        password,
        status: UserStatus.NEW
      }
    });
  }

  async updateStatus(tx: PrismaClient, userId: string, status: UserStatus) {
    return tx.user.update({
      where: { id: userId },
      data: { status }
    });
  }

  async listActive(tx: PrismaClient) {
    return tx.user.findMany({
      where: {
        ...this.buildTenantFilter(tx),
        status: UserStatus.ACTIVE
      }
    });
  }
}
