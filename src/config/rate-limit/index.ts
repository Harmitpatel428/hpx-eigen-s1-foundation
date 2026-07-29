import { RateLimitConfig } from './base';
import { productionConfig } from './production';
import { developmentConfig } from './development';
import { testConfig } from './test';

export class RateLimitFactory {
  static getPolicy(env: string = process.env.NODE_ENV || 'development'): RateLimitConfig {
    switch (env) {
      case 'production':
      case 'staging':
        return productionConfig;
      case 'test':
      case 'ci':
        return testConfig;
      case 'development':
      default:
        return developmentConfig;
    }
  }
}
