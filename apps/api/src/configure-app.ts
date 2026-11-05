import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { ConfigService } from './config/config.service';
import { ErrorFilter } from './common/error.filter';
export function configureApp(app: NestExpressApplication) {
  const config = app.get(ConfigService);
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());
  // Nest's rawBody option captures exact webhook bytes before JSON parsing.
  app.useBodyParser('json', { limit: '1mb' });
  app.enableCors({
    origin: new URL(config.env.FRONTEND_URL).origin,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.useGlobalFilters(new ErrorFilter());
}
