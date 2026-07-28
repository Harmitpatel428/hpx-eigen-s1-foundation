import { z } from 'zod';

export const signupSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(8, 'Password must be at least 8 chars')
      .regex(/[A-Z]/, 'Password must contain 1 uppercase')
      .regex(/[0-9]/, 'Password must contain 1 number'),
    companyName: z.string().min(2, 'Company name must be at least 2 chars'),
  }),
});

export const verifySchema = z.object({
  query: z.object({
    token: z.string().length(64, 'Invalid token format'),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(1, 'Password is required'),
    deviceName: z.string().optional(),
  }),
});

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().regex(/^[a-zA-Z0-9-]+\.[a-f0-9]{128}$/, 'Invalid refresh token format'),
  }),
});

// Reusable types for your controllers
export type SignupInput = z.infer<typeof signupSchema>['body'];
export type LoginInput = z.infer<typeof loginSchema>['body'];
