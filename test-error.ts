import { ValidationError, AppException } from './src/types/exceptions';

const err = new ValidationError('test');
console.log('instanceof AppException:', err instanceof AppException);
