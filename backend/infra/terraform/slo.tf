# 가용성 SLO의 소진 속도 알림과 SLO 대시보드(ADR-0016 1절, T62). 밖에서 도는 점검(Route 53)은 account/에 있다.
#
# 소진 속도 = 창 안의 오류율 ÷ (1 - 목표). CloudWatch의 SLO 기능과 같은 식이다. 그 기능의 자원이 Terraform AWS 제공자에
# 없어(6.73) 지표 계산 알림으로 건다. CloudWatch 알림은 1분마다, 시계에 맞추지 않고 미끄러지는 창(기간 × 1)으로 평가한다.
#   오류 = ALB 자신의 5xx + 대상(API)의 5xx
#   전체 = 요청 수 - 대상의 4xx + ALB 자신의 5xx
#     ALB가 대상을 고르지 못해 낸 5xx(건강한 대상이 없을 때의 503 등)는 요청 수(RequestCount)에 들지 않아 더한다.
#     대상을 고른 뒤의 502·504는 두 번 들어가 오류율이 조금 낮게 나온다. 4xx는 ADR대로 뺀다(ALB 자신의 4xx는 원래 요청 수에 없음)
# 알림을 받을 곳(메일·메신저)은 두지 않았다. 상태는 CloudWatch 알림 목록과 ops 워크플로의 status에서 본다.
# ALB는 컨트롤러가 만들어(edge.tf) ALB가 있을 때만 건다. 접으면 같이 지워지고, 다시 펴면 새 ALB의 지표로 처음부터 센다
# (대시보드의 30일도 이 ALB가 생긴 뒤부터).
locals {
  slo_goal = 0.995
  burn = { # 창 이름 → 창의 초, 울리는 소진 속도(ADR-0016: 1시간 14.4, 6시간 6)
    "1h" = { seconds = 3600, rate = 14.4 }
    "6h" = { seconds = 21600, rate = 6 }
  }
  alb_metrics = { # 지표 계산식의 이름 → ALB 지표
    req  = "RequestCount"
    elb5 = "HTTPCode_ELB_5XX_Count"
    tgt5 = "HTTPCode_Target_5XX_Count"
    tgt4 = "HTTPCode_Target_4XX_Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "burn" {
  for_each            = local.alb_arn == null ? {} : local.burn
  alarm_name          = "gachita-${var.env}-availability-burn-${each.key}"
  alarm_description   = "가용성 SLO ${local.slo_goal * 100}%의 ${each.key} 소진 속도가 ${each.value.rate} 이상(ADR-0016). 둘 다 울리면 배포를 멈추고 원인을 본다"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = each.value.rate
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching" # 요청이 없으면 예산을 쓰지 않는다

  metric_query {
    id          = "burn"
    label       = "소진 속도(${each.key})"
    expression  = "IF(total > 0, bad / total, 0) / ${format("%.3f", 1 - local.slo_goal)}" # 0.005
    return_data = true
  }
  metric_query {
    id         = "bad"
    expression = "FILL(elb5, 0) + FILL(tgt5, 0)"
  }
  metric_query {
    id         = "total"
    expression = "FILL(req, 0) - FILL(tgt4, 0) + FILL(elb5, 0)"
  }
  dynamic "metric_query" {
    for_each = local.alb_metrics
    content {
      id = metric_query.key
      metric {
        namespace   = "AWS/ApplicationELB"
        metric_name = metric_query.value
        dimensions  = { LoadBalancer = data.aws_lb.cluster[0].arn_suffix }
        period      = each.value.seconds
        stat        = "Sum"
      }
    }
  }
}

# 30일 SLO를 보는 곳. 기간 전체 값(setPeriodToTimeRange)이라 기간을 30일로 두면 30일 SLI다.
#   가용성: 위 알림과 같은 식. 지연: 대상 응답 시간의 백분위 순위(PR, 그 시간 안에 끝난 요청의 비율). ALB 지표에는 경로가 없어
#   ADR의 '조회(GET /api/trips/:code) 200 ms'와 '쓰기 1초'를 모든 요청에 대고 잰다
resource "aws_cloudwatch_dashboard" "slo" {
  count          = local.alb_arn == null ? 0 : 1
  dashboard_name = "gachita-${var.env}-slo"
  dashboard_body = jsonencode({
    start = "-P30D"
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 8, height = 6
        properties = {
          title = "가용성 SLI(목표 ${local.slo_goal * 100}%)", view = "singleValue", region = var.region, stat = "Sum", setPeriodToTimeRange = true
          metrics = concat(
            [[{ expression = "100 * (1 - (FILL(elb5, 0) + FILL(tgt5, 0)) / (FILL(req, 0) - FILL(tgt4, 0) + FILL(elb5, 0)))", label = "가용성 %", id = "sli" }]],
            [for id, name in local.alb_metrics : ["AWS/ApplicationELB", name, "LoadBalancer", data.aws_lb.cluster[0].arn_suffix, { id = id, visible = false }]]
          )
        }
      },
      {
        type = "metric", x = 8, y = 0, width = 8, height = 6
        properties = {
          title = "지연 SLI(목표 99%)", view = "singleValue", region = var.region, setPeriodToTimeRange = true
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", data.aws_lb.cluster[0].arn_suffix, { stat = "PR(:0.2)", label = "200 ms 안 %" }],
            ["...", { stat = "PR(:1)", label = "1초 안 %" }],
          ]
        }
      },
      {
        type       = "alarm", x = 16, y = 0, width = 8, height = 6
        properties = { title = "소진 속도 알림", alarms = [for a in aws_cloudwatch_metric_alarm.burn : a.arn] }
      },
    ]
  })
}
