import { PostScreenShotSchema } from "../../modules/post-screenshot/dto";
import { CreatePostScreenShotSwagger } from "../../modules/post-screenshot/post-screenshot.swagger";
import {
  LoginCodeSchema,
  LoginPasswordSchema,
  LoginResponseSchema,
  LoginStartSchema,
  ReloginSchema,
  SessionResponseSchema,
  TestScreenshotSchema,
  UpdateSessionSchema,
  UpsertSessionSchema,
} from "../../modules/sessions/dto";
import { SESSIONS_SWAGGER_ROUTES } from "../../modules/sessions/sessions.swagger";
import { ENUM_REGISTER_ROUTE } from "./register.enum";

export const SWAGGER_ROUTES = [CreatePostScreenShotSwagger, ...SESSIONS_SWAGGER_ROUTES]

export const SWAGGER_SCHEMAS = [
  { name: ENUM_REGISTER_ROUTE.POST_SCREENSHOT, schema: PostScreenShotSchema },
  { name: ENUM_REGISTER_ROUTE.UPSERT_SESSION, schema: UpsertSessionSchema },
  { name: ENUM_REGISTER_ROUTE.UPDATE_SESSION, schema: UpdateSessionSchema },
  { name: ENUM_REGISTER_ROUTE.SESSION, schema: SessionResponseSchema },
  { name: ENUM_REGISTER_ROUTE.TEST_SCREENSHOT, schema: TestScreenshotSchema },
  { name: ENUM_REGISTER_ROUTE.LOGIN_START, schema: LoginStartSchema },
  { name: ENUM_REGISTER_ROUTE.RELOGIN, schema: ReloginSchema },
  { name: ENUM_REGISTER_ROUTE.LOGIN_CODE, schema: LoginCodeSchema },
  { name: ENUM_REGISTER_ROUTE.LOGIN_PASSWORD, schema: LoginPasswordSchema },
  { name: ENUM_REGISTER_ROUTE.LOGIN, schema: LoginResponseSchema },
];
