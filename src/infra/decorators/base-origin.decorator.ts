import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const BaseOrigin = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user?.baseOrigin;
  },
);
