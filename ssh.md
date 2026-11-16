scp /Users/xiangxuetong.vendor/Desktop/rating_bg\rating_v43.zip sensebench@101.89.57.33:/home/sensebench/sunwenxiu

scp /Users/xiangxuetong.vendor/Desktop/rating_bg/rating_v52.zip sensebench@101.89.57.33:/home/sensebench/sunwenxiu/

scp /mnt/aigc/zengjianye/projects/data/high_density_infographic_50k_balanced_20261029/final-data/high_density_infogrphic_50k/zip_shards/part_001.zip sensebench@101.89.57.33:/data/sunwenxiu/rating/inbox/high_density_infographic

ssh sensebench@101.89.57.33

docker compose down

WEB_PORT=8001 docker compose up -d

WEB_PORT=8001 docker compose up -d --build

docker ps

scp D:\v030_data\08-29-3.zip sensebench@101.89.57.33:/data/sunwenxiu/rating/inbox/rating_v8.zip.part

ssh sensebench@101.89.57.33 mv /data/sunwenxiu/rating/inbox/rating_v8.zip.part/data/sunwenxiu/rating/inbox/rating_v8.zip

然后你把这个 zip 包上传到我的 sftp 命令类似 scp D:\v030_data\"这里使用你整合好的 zip 包名" sensebench@101.89.57.33:/data/sunwenxiu/rating/inbox/ 你的包名，

然后你需要实时检查上传进度

上传完成后执行：

ssh sensebench@101.89.57.33 mv /data/sunwenxiu/rating/inbox/ 这里使用你整合好的 zip 包名 /data/sunwenxiu/rating/inbox/ 这里使用你整合好的 zip 包名

然后触发容器内导入：

ssh sensebench@101.89.57.33 cd /home/sensebench/sunwenxiu/rating_v9 && docker compose exec -T api node src/import-local.js/app/inbox/ 这里使用你整合好的 zip 包名

等待导入完成后告诉我


./ads-cli --threads 20 cp /mnt/aigc/zengjianye/projects/data/color/u-rollout/shards/zip_shards s3://01A18E3CD5977D89A54F39279D4C9B53: 01A18E3CD5977D89A54F39279D4C9B53@devsft-datashare-b.10.118.0.160/zip_shards
./ads-cli --threads 20 cp /mnt/aigc/zoedatasets_u1x/aes/label/realism_pairs_30k_mj60_other40_portrait70_general30_20261103/zip_shards
s3://01A18E3CD5977D89A54F39279D4C9B53:01A18E3CD5977D7B96A56322D6030364@sunqingping.10.118.0.159/realism_1104


/mnt/aigc/zengjianye/projects/data/color/u-rollout/shards/zip_shards
/mnt/aigc/zengjianye/projects/data/real/shards/zip_shards
 /mnt/aigc/users/sunqingping/infographics/rl_data/scripts/aes_v2/training_file/creativity_pair_delivery_20261102_one_nonwan_per_reference/01_gt_original_vs_rewrite/zip_shards
/mnt/aigc/users/sunqingping/infographics/rl_data/scripts/aes_v2/training_file/creativity_pair_delivery_20261102_one_nonwan_per_reference/02_u_gen_vs_improved/zip_shards
/mnt/aigc/zengjianye/projects/data/human/u-rollout/anatomy_u16_bottom20k_random20k_balanced_20261102/shards/zip_shards
/mnt/aigc/zoedatasets_u1x/aes/label/illustration_creativity_pairs_30k_mj60_huiting20_lzq10_other10_20261102/zip_shards/
/mnt/aigc/zoedatasets_u1x/aes/label/illustration_creativity_pairs_30k_mj60_huiting20_lzq10_other10_20261102

/mnt/aigc/zoedatasets_u1x/aes/label/illustration_color_pairs_30k_mj60_huiting20_lzq10_other10_20261102/zip_shards/
/mnt/aigc/zoedatasets_u1x/aes/label/realism_pairs_30k_mj60_other40_portrait70_general30_20261103/zip_shards/


Tong0403+

~/bin/ads-cli --threads 20 cp \
  "s3://01A18E3CD5977D89A54F39279D4C9B53:01A18E3CD5977D7B96A56322D6030364@sunqingping.10.118.0.159/illustration_color_pairs_30k/" \
  /data/sunwenxiu/rating/inbox/20261102_08/


/mnt/aigc/zengjianye/projects/data/creative/u-rollout/shards/zip_shards




./ads-cli --threads 20 cp /mnt/aigc/zengjianye/projects/data/creative/u-rollout/shards/zip_shards s3://01A19C718ADF7182B49DA597DBDA0760:01A19C718ADF70D2ABBFBE65B292867C@devsft.10.118.36.160/creative_zip_shards_1102






