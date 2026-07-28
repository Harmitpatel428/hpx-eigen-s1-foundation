import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ValidationError } from '../types/exceptions';

export const validate = (schema: ZodSchema) => 
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      // Parse and overwrite req.body, req.query, req.params with sanitized data
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      }) as { body: any; query: any; params: any };
      
      req.body = parsed.body;
      Object.defineProperty(req, 'query', { value: parsed.query, enumerable: true, writable: true, configurable: true });
      Object.defineProperty(req, 'params', { value: parsed.params, enumerable: true, writable: true, configurable: true });
      
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        // Flatten Zod issues into a readable string
        const message = err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
        next(new ValidationError(message));
      } else {
        next(err);
      }
    }
  };
