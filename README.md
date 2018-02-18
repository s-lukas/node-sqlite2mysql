# sqlite2mysql
Imports all tables from SQlite to MySQL ___without___ recreating structure/schema

## Installation
    $ npm install -g sqlite2mysql

## Usage

    $ sqlite2mysql [--dry-run] [--charset <charset>] [--prefix <prefix>] /path/to/db.sqlite mysql://user:password@host:port/database

## How it works
* Requires tables in MySQL-Database to exist (doesn't create schema/tables)
* Copies only data to existing tables &amp; fields
* Automatically generates default values for non-existent fields
    * NULL for nullable fields
    * Valid timestamps (1970-01-01 00:00:01 UTC) for non-nullable TIMESTAMP-fields
    * '' for non-nullable TEXT-fields
    * 1|0 for BOOLEAN (accepts NULL,true,false,0,1,'','0','1','true','false',...)
    * etc.
