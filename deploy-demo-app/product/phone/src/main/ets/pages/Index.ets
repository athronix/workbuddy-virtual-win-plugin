// 宿主框架层挂载页：仅加载功能 HAR 的部署页面，无任何业务代码
import { DeployPage } from 'winvm_onetap';

@Entry
@Component
struct Index {
  build() {
    Column() {
      DeployPage()
    }
    .width('100%')
    .height('100%')
  }
}
