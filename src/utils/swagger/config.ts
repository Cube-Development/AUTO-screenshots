import { PostScreenShotSchema } from "../../modules/post-screenshot/dto";
import { CreatePostScreenShotSwagger } from "../../modules/post-screenshot/post-screenshot.swagger";
import { ENUM_REGISTER_ROUTE } from "./register.enum";

export const SWAGGER_ROUTES = [CreatePostScreenShotSwagger] 

export const SWAGGER_SCHEMAS = [
  {
    name:ENUM_REGISTER_ROUTE.POST_SCREENSHOT,
    schema: PostScreenShotSchema
  }
];