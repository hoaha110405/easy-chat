import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from './api-error';
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof ApiError) {
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        },
      });
      return;
    }
    const status = error instanceof HttpException ? error.getStatus() : 500;
    if (status === 500)
      this.logger.error(
        'Request failed; inspect database availability and server configuration.',
      );
    response.status(status).json({
      error: {
        code:
          status === 401
            ? 'UNAUTHORIZED'
            : status === 429
              ? 'RATE_LIMITED'
              : 'REQUEST_FAILED',
        message:
          status === 500
            ? 'The server could not complete this request. Please try again.'
            : error instanceof HttpException
              ? error.message
              : 'Request failed',
      },
    });
  }
}
